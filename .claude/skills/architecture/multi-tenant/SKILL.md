---
name: multi-tenant-architecture
description: This skill should be used when the user asks about "multi-tenant", "tenant isolation", "Liverpool vs Suburbia", "factory pattern", "request-scoped", "tenant resolution", or mentions tenant-specific implementations, database separation, or provider-based routing.
---

# Multi-Tenant Architecture - NOVA Microservicio Autos

## Objetivo

Implementar y mantener correctamente la arquitectura **multi-tenant** del microservicio, asegurando aislamiento de datos entre Liverpool y Suburbia.

---

## Arquitectura Multi-Tenant

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         HTTP REQUEST                                         │
│                    (JWT with tenant claim)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      AuthContextService                                      │
│              (Extracts tenant from JWT: 'liverpool' | 'suburbia')            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Module Factory                                       │
│                    (Request-scoped provider)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    const dataSourceBuilder = {                                               │
│      liverpool: () => new EntityLiverpoolMsSqlDataSources(prisma.liverpool) │
│      suburbia:  () => new EntitySuburbiaMsSqlDataSources(prisma.suburbia)   │
│    }                                                                         │
│                                                                              │
│    return new EntityImplRepository(dataSourceBuilder[tenant]())              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
    ┌──────────────────────────┐    ┌──────────────────────────┐
    │   Liverpool DataSource   │    │   Suburbia DataSource    │
    │                          │    │                          │
    │   PrismaClient Liverpool │    │   PrismaClient Suburbia  │
    │   qa_liverpool_autos     │    │   qa_suburbia_autos      │
    └──────────────────────────┘    └──────────────────────────┘
```

---

## 1. Tenant Resolution

### AuthContextService

```typescript
// src/infrastructure/auth/context/auth-context.service.ts

@Injectable({ scope: Scope.REQUEST })
export class AuthContextService {
  private _tenant: ProviderType;

  constructor(@Inject(REQUEST) private request: Request) {
    // Extract tenant from JWT claims
    this._tenant = this.extractTenantFromToken();
  }

  get tenant(): ProviderType {
    return this._tenant;
  }

  private extractTenantFromToken(): ProviderType {
    // JWT payload contains: { ..., tenant: 'liverpool' | 'suburbia' }
    const token = this.request.headers.authorization?.split(' ')[1];
    const decoded = this.jwtService.decode(token);
    return decoded.tenant;
  }
}
```

### ProviderType Definition

```typescript
// src/shared/types/provider.type.ts

export type ProviderType = 'liverpool' | 'suburbia';
```

---

## 2. Module Factory Pattern

### Complete Module Configuration

```typescript
// presentation/{entity}/{entity}.module.ts

import { Module, Scope, Logger } from '@nestjs/common';
import { EntityService } from './{entity}.service';
import { EntityController } from './{entity}.controller';
import { EntityImplRepository } from '../../infrastructure/repositories/{entity}-impl.repository';
import {
  EntityLiverpoolMsSqlDataSources,
  EntitySuburbiaMsSqlDataSources,
} from '../../infrastructure/data-sources/{entity}-impl.data-sources';
import { PrismaMultiTenantService } from '@/infrastructure/prisma/prisma-multi-tenant.service';
import { AuthContextService } from '@/infrastructure/auth';

const logger = new Logger('EntityModule');

@Module({
  imports: [],
  controllers: [EntityController],
  providers: [
    EntityService,
    {
      provide: 'EntityRepository',
      scope: Scope.REQUEST, // ⚠️ CRITICAL: Must be request-scoped
      useFactory: (
        prismaMultiTenant: PrismaMultiTenantService,
        authContext: AuthContextService,
      ) => {
        // 1. Get tenant from authenticated request
        const tenant = authContext.tenant;

        logger.debug(`🏭 Creating EntityRepository for tenant: ${tenant}`);

        // 2. Build tenant-specific DataSource
        const dataSourceBuilder = {
          suburbia: () =>
            new EntitySuburbiaMsSqlDataSources(prismaMultiTenant.suburbia),
          liverpool: () =>
            new EntityLiverpoolMsSqlDataSources(prismaMultiTenant.liverpool),
        };

        // 3. Create DataSource for this request's tenant
        const dataSource = dataSourceBuilder[tenant]();

        logger.debug(`✅ DataSource created: ${dataSource.constructor.name}`);

        // 4. Return Repository wrapping the DataSource
        return new EntityImplRepository(dataSource);
      },
      inject: [PrismaMultiTenantService, AuthContextService],
    },
  ],
  exports: [EntityService],
})
export class EntityModule {}
```

---

## 3. PrismaMultiTenantService

```typescript
// src/infrastructure/prisma/prisma-multi-tenant.service.ts

@Injectable()
export class PrismaMultiTenantService {
  constructor(
    private readonly liverpoolService: PrismaLiverpoolService,
    private readonly suburbiaService: PrismaSuburbiaService,
  ) {}

  get liverpool() {
    return this.liverpoolService;
  }

  get suburbia() {
    return this.suburbiaService;
  }
}
```

### Tenant-Specific Prisma Services

```typescript
// src/infrastructure/prisma/prisma-liverpool.service.ts
import { PrismaClient } from '.prisma/client-liverpool';

@Injectable()
export class PrismaLiverpoolService extends PrismaClient {
  constructor() {
    super({
      datasources: {
        db: { url: process.env.DATABASE_URL_LIVERPOOL },
      },
    });
  }
}

// src/infrastructure/prisma/prisma-suburbia.service.ts
import { PrismaClient } from '.prisma/client-suburbia';

@Injectable()
export class PrismaSuburbiaService extends PrismaClient {
  constructor() {
    super({
      datasources: {
        db: { url: process.env.DATABASE_URL_SUBURBIA },
      },
    });
  }
}
```

---

## 4. Tenant-Specific Fields

### Schema Differences

| Field           | Liverpool | Suburbia | Purpose           |
| --------------- | --------- | -------- | ----------------- |
| `vin`           | ✅        | ❌       | Vehicle ID Number |
| `mileage`       | ✅        | ❌       | Kilometraje       |
| `interiorColor` | ✅        | ❌       | Color interior    |
| `hasWarranty`   | ✅        | ❌       | Tiene garantía    |
| `discount`      | ❌        | ✅       | Descuento         |
| `category`      | ❌        | ✅       | Categoría         |
| `isFeatured`    | ❌        | ✅       | Es destacado      |

### Handling in Use Case

```typescript
// domain/use-case/entity/create-entity.usecase.ts

export class CreateEntityUseCase implements UseCaseGeneric<CreateEntityDto> {
  constructor(private readonly repository: EntityRepositoryDto) {}

  async execute(dto: CreateEntityDto, provider: ProviderType) {
    // Build tenant-specific payload
    const payload =
      provider === 'liverpool'
        ? this.buildLiverpoolPayload(dto)
        : this.buildSuburbiaPayload(dto);

    const data = await this.repository.create(payload);
    return { data };
  }

  private buildLiverpoolPayload(dto: CreateEntityDto) {
    // Extract Suburbia-only fields and validate they're not present
    const { discount, category, isFeatured, ...liverpoolData } = dto;

    this.validateNoExtraFields(
      { discount, category, isFeatured },
      'Suburbia',
      'Liverpool',
    );

    return liverpoolData;
  }

  private buildSuburbiaPayload(dto: CreateEntityDto) {
    // Extract Liverpool-only fields and validate they're not present
    const { vin, mileage, interiorColor, hasWarranty, ...suburbiaData } = dto;

    this.validateNoExtraFields(
      { vin, mileage, interiorColor, hasWarranty },
      'Liverpool',
      'Suburbia',
    );

    return suburbiaData;
  }

  private validateNoExtraFields(
    fields: Record<string, unknown>,
    belongsTo: string,
    currentProvider: string,
  ) {
    const invalid = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);

    if (invalid.length) {
      throw CustomError.badRequest({
        description: `[${invalid.join(', ')}] son exclusivos de ${belongsTo}, no disponibles en ${currentProvider}.`,
      });
    }
  }
}
```

---

## 5. DataSource Implementations

### Liverpool DataSource

```typescript
// infrastructure/data-sources/entity-impl.data-sources/entity-liverpool-mssql.data-sources.ts

import { PrismaClient } from '.prisma/client-liverpool';

export class EntityLiverpoolMsSqlDataSources implements EntityDataSourcesDto {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dto: CreateEntityDto): Promise<EntityDto> {
    const liverpoolData = {
      // Shared fields
      name: dto.name,
      description: dto.description,
      // Liverpool-specific fields
      vin: dto.vin,
      mileage: dto.mileage,
      interiorColor: dto.interiorColor,
      hasWarranty: dto.hasWarranty,
    };

    try {
      return await this.prisma.entity.create({ data: liverpoolData });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw CustomError.badRequest({
          description: `El VIN "${dto.vin}" ya existe en la base de datos.`,
        });
      }
      throw error;
    }
  }

  // ... other methods
}
```

### Suburbia DataSource

```typescript
// infrastructure/data-sources/entity-impl.data-sources/entity-suburbia-mssql.data-sources.ts

import { PrismaClient } from '.prisma/client-suburbia';

export class EntitySuburbiaMsSqlDataSources implements EntityDataSourcesDto {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dto: CreateEntityDto): Promise<EntityDto> {
    const suburbiaData = {
      // Shared fields
      name: dto.name,
      description: dto.description,
      // Suburbia-specific fields
      discount: dto.discount,
      category: dto.category,
      isFeatured: dto.isFeatured,
    };

    return await this.prisma.entity.create({ data: suburbiaData });
  }

  // ... other methods
}
```

---

## 6. Testing Multi-Tenant

```typescript
describe('Multi-tenant behavior', () => {
  describe.each(['liverpool', 'suburbia'] as const)('Tenant: %s', tenant => {
    it(`should create entity for ${tenant}`, async () => {
      const result = await useCase.execute(dto, tenant);
      expect(result.data).toBeDefined();
    });
  });

  it('should reject Liverpool fields for Suburbia', async () => {
    const dto = { ...baseDto, vin: 'ABC123' };
    await expect(useCase.execute(dto, 'suburbia')).rejects.toThrow();
  });

  it('should reject Suburbia fields for Liverpool', async () => {
    const dto = { ...baseDto, discount: 10 };
    await expect(useCase.execute(dto, 'liverpool')).rejects.toThrow();
  });
});
```

---

## 7. Common Pitfalls

### ❌ Forgetting Request Scope

```typescript
// WRONG - Missing scope
{
  provide: 'EntityRepository',
  useFactory: (...) => { ... },
  inject: [...],
}

// CORRECT
{
  provide: 'EntityRepository',
  scope: Scope.REQUEST,  // ✅ Required for tenant isolation
  useFactory: (...) => { ... },
  inject: [...],
}
```

### ❌ Wrong Prisma Client Import

```typescript
// WRONG - Using wrong client
import { PrismaClient } from '@prisma/client';

// CORRECT - Liverpool
import { PrismaClient } from '.prisma/client-liverpool';

// CORRECT - Suburbia
import { PrismaClient } from '.prisma/client-suburbia';
```

### ❌ Not Passing Provider to UseCase

```typescript
// WRONG
const result = await new CreateUseCase(repo).execute(dto);

// CORRECT
const result = await new CreateUseCase(repo).execute(dto, provider);
```

---

## 8. Checklist for New Multi-Tenant Module

- [ ] Prisma schemas updated for BOTH tenants
- [ ] Prisma clients regenerated
- [ ] Abstract interfaces defined (DataSource, Repository)
- [ ] Liverpool DataSource implementation
- [ ] Suburbia DataSource implementation
- [ ] Repository implementation
- [ ] Use Case handles tenant-specific logic
- [ ] Module uses request-scoped factory
- [ ] Controller passes `authContext.tenant` to service
- [ ] Tests cover both tenants
- [ ] Tenant-specific field validation
