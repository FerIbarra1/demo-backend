---
name: audit-logging
description: This skill should be used when the user asks about "audit logging", "activity tracking", "audit trail", "log actions", or mentions tracking changes, logging operations, or recording user actions.
---

# Audit Logging - NOVA Microservicio Autos

## Objetivo

Implementar correctamente el sistema de **audit logging** para tracking de operaciones, cambios de datos, y cumplimiento de trazabilidad.

---

## Arquitectura de Audit Log

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AUDIT LOG FLOW                                       │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────────────────────────┐
│  Controller  │ ──▶ │   Service    │ ──▶ │  AuditLogService.create()        │
│              │     │              │     │  (fire-and-forget)               │
└──────────────┘     └──────────────┘     └──────────────┬───────────────────┘
                                                         │
                                                         ▼
                     ┌──────────────────────────────────────────────────────┐
                     │                   AuditLog Table                      │
                     │                                                       │
                     │  provider | action | entity | entityId | requestBody │
                     │  response | status | method | endpoint | duration    │
                     └──────────────────────────────────────────────────────┘
```

---

## 1. AuditLog Model

### Prisma Schema (Both Tenants)

```prisma
// prisma/liverpool/schema.prisma
// prisma/suburbia/schema.prisma

model AuditLog {
    id           String   @id @default(cuid())
    provider     String   // liverpool, suburbia
    action       String   // CREATE, UPDATE, DELETE, READ
    status       String   // SUCCESS, ERROR, PENDING
    entity       String   // car, user, etc.
    entityId     String?  // ID del recurso afectado
    method       String   // GET, POST, PUT, PATCH, DELETE
    endpoint     String   // /api/cars, /api/users, etc.
    requestBody  String?  @db.Text  // Body del request (JSON string)
    response     String?  @db.Text  // Response del request (JSON string)
    errorMessage String?  @db.Text  // Mensaje de error si status = ERROR
    userAgent    String?  // User agent del request
    ipAddress    String?  // IP address del request
    duration     Int?     // Duración en milisegundos
    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt

    @@index([provider])
    @@index([status])
    @@index([action])
    @@index([entity])
    @@index([createdAt])
    @@map("audit_logs")
}
```

---

## 2. AuditLogService

### Service Interface

```typescript
// src/infrastructure/audit-log/presentation/audit-log/audit-log.service.ts

import { Injectable, Inject } from '@nestjs/common';
import { AuditLogRepositoryDto } from '../../domain/repositories/audit-log.data-repository';
import { CreateAuditLogDto } from '../../domain/dtos/audit-log/create-audit-log.dto';
import { ProviderType } from '@/shared';

@Injectable()
export class AuditLogService {
  constructor(
    @Inject('AuditLogRepository')
    private readonly auditLogRepository: AuditLogRepositoryDto,
  ) {}

  /**
   * Create audit log entry
   * Fire-and-forget pattern - don't await, don't block main flow
   */
  async create(dto: CreateAuditLogDto, provider: ProviderType): Promise<void> {
    try {
      await this.auditLogRepository.create(dto);
    } catch (error) {
      // Log error but don't throw - audit logging should never block operations
      console.error('Audit log creation failed:', error);
    }
  }
}
```

### CreateAuditLogDto

```typescript
// domain/dtos/audit-log/create-audit-log.dto.ts

export class CreateAuditLogDto {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'READ';
  status: 'SUCCESS' | 'ERROR' | 'PENDING';
  entity: string;
  entityId?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpoint: string;
  requestBody?: string;
  response?: string;
  errorMessage?: string;
  userAgent?: string;
  ipAddress?: string;
  duration?: number;
  provider: ProviderType;
}
```

---

## 3. Usage in Services

### Pattern: Fire-and-Forget

```typescript
// src/core/car/presentation/car/car.service.ts

import { Injectable, Inject } from '@nestjs/common';
import { AuditLogService } from '@/infrastructure/audit-log';
import { ProviderType } from '@/shared';

@Injectable()
export class CarService {
  private readonly ENTITY = 'car';
  private readonly BASE_ENDPOINT = '/api/cars';

  constructor(
    @Inject('CarRepository')
    private readonly carRepository: CarRepositoryDto,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateCarDto, provider: ProviderType) {
    // 1. Execute business operation
    const result = await new CreateCarUseCase(this.carRepository).execute(
      dto,
      provider,
    );

    // 2. Log audit (fire-and-forget - don't await in main flow)
    this.auditLogService
      .create(
        {
          action: 'CREATE',
          status: 'SUCCESS',
          entity: this.ENTITY,
          method: 'POST',
          endpoint: this.BASE_ENDPOINT,
          requestBody: JSON.stringify(dto),
          response: JSON.stringify(result),
          provider,
        },
        provider,
      )
      .catch(() => {}); // Silently catch - don't affect main operation

    return result;
  }

  async update(idDto: CarIdDto, data: UpdateCarDto, provider: ProviderType) {
    const result = await new UpdateCarUseCase(this.carRepository).execute(
      { idDto, data },
      provider,
    );

    this.auditLogService
      .create(
        {
          action: 'UPDATE',
          status: 'SUCCESS',
          entity: this.ENTITY,
          entityId: idDto.id,
          method: 'PATCH',
          endpoint: `${this.BASE_ENDPOINT}/${idDto.id}`,
          requestBody: JSON.stringify({ idDto, data }),
          response: JSON.stringify(result),
          provider,
        },
        provider,
      )
      .catch(() => {});

    return result;
  }

  async remove(dto: CarIdDto, provider: ProviderType) {
    const result = await new RemoveCarUseCase(this.carRepository).execute(
      dto,
      provider,
    );

    this.auditLogService
      .create(
        {
          action: 'DELETE',
          status: 'SUCCESS',
          entity: this.ENTITY,
          entityId: dto.id,
          method: 'DELETE',
          endpoint: `${this.BASE_ENDPOINT}/${dto.id}`,
          response: JSON.stringify(result),
          provider,
        },
        provider,
      )
      .catch(() => {});

    return result;
  }
}
```

---

## 4. Error Logging Pattern

### Log Errors with Context

```typescript
async create(dto: CreateCarDto, provider: ProviderType) {
  try {
    const result = await new CreateCarUseCase(this.carRepository).execute(
      dto,
      provider,
    );

    // Log success
    this.auditLogService
      .create({
        action: 'CREATE',
        status: 'SUCCESS',
        entity: this.ENTITY,
        method: 'POST',
        endpoint: this.BASE_ENDPOINT,
        requestBody: JSON.stringify(dto),
        response: JSON.stringify(result),
        provider,
      }, provider)
      .catch(() => {});

    return result;
  } catch (error) {
    // Log error
    this.auditLogService
      .create({
        action: 'CREATE',
        status: 'ERROR',
        entity: this.ENTITY,
        method: 'POST',
        endpoint: this.BASE_ENDPOINT,
        requestBody: JSON.stringify(dto),
        errorMessage: error.message || 'Unknown error',
        provider,
      }, provider)
      .catch(() => {});

    // Re-throw the error
    throw error;
  }
}
```

---

## 5. Module Configuration

### AuditLogModule

```typescript
// src/infrastructure/audit-log/audit-log.module.ts

import { Module, Scope, Global } from '@nestjs/common';
import { AuditLogService } from './presentation/audit-log/audit-log.service';
import { AuditLogImplRepository } from './infrastructure/repositories/audit-log-impl.repository';
import {
  AuditLogLiverpoolMsSqlDataSources,
  AuditLogSuburbiaMsSqlDataSources,
} from './infrastructure/data-sources/audit-log-impl.data-sources';
import { PrismaMultiTenantService } from '@/infrastructure/prisma/prisma-multi-tenant.service';
import { AuthContextService } from '@/infrastructure/auth';

@Global() // Make available everywhere
@Module({
  providers: [
    AuditLogService,
    {
      provide: 'AuditLogRepository',
      scope: Scope.REQUEST,
      useFactory: (prismaMultiTenant, authContext) => {
        const tenant = authContext.tenant;
        const dataSourceBuilder = {
          liverpool: () =>
            new AuditLogLiverpoolMsSqlDataSources(prismaMultiTenant.liverpool),
          suburbia: () =>
            new AuditLogSuburbiaMsSqlDataSources(prismaMultiTenant.suburbia),
        };
        return new AuditLogImplRepository(dataSourceBuilder[tenant]());
      },
      inject: [PrismaMultiTenantService, AuthContextService],
    },
  ],
  exports: [AuditLogService],
})
export class AuditLogMainModule {}
```

### Import in Feature Module

```typescript
// src/core/car/presentation/car/car.module.ts

import { AuditLogMainModule } from '@/infrastructure/audit-log/audit-log.module';

@Module({
  imports: [AuditLogMainModule],
  // ...
})
export class CarModule {}
```

---

## 6. Querying Audit Logs

### Find by Entity

```typescript
async findByEntity(entity: string, query: FindAllAuditLogQuery) {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    this.prisma.auditLog.findMany({
      where: { entity },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    this.prisma.auditLog.count({ where: { entity } }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}
```

### Find by Entity ID

```typescript
async findByEntityId(entity: string, entityId: string) {
  return this.prisma.auditLog.findMany({
    where: { entity, entityId },
    orderBy: { createdAt: 'desc' },
  });
}
```

---

## 7. Best Practices

### ✅ DO

```typescript
// Fire-and-forget - don't block main operation
this.auditLogService.create(dto, provider).catch(() => {});

// Log both success and error
try {
  const result = await operation();
  this.auditLogService.create({ status: 'SUCCESS', ... });
  return result;
} catch (error) {
  this.auditLogService.create({ status: 'ERROR', ... });
  throw error;
}

// Include relevant context
{
  entity: 'car',
  entityId: car.id,
  action: 'UPDATE',
  requestBody: JSON.stringify(dto),
  response: JSON.stringify(result),
}
```

### ❌ DON'T

```typescript
// Don't await in main flow - it will slow down the API
await this.auditLogService.create(dto, provider);

// Don't log sensitive data
{
  requestBody: JSON.stringify({ password: '...', creditCard: '...' }),
}

// Don't let audit errors break the main flow
const auditResult = await this.auditLogService.create(dto, provider);
// If this throws, the main operation fails
```

---

## 8. Checklist

- [ ] AuditLog model in both Prisma schemas
- [ ] AuditLogService injected in feature services
- [ ] Fire-and-forget pattern used
- [ ] Both success and error states logged
- [ ] Entity and entityId properly set
- [ ] RequestBody and Response JSON stringified
- [ ] No sensitive data in logs
- [ ] Indexes on frequently queried fields
