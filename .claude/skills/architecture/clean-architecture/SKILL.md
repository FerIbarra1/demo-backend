---
name: clean-architecture
description: This skill should be used when the user asks about "clean architecture", "ports and adapters", "hexagonal architecture", "layer separation", "domain layer", "use case pattern", or mentions architectural boundaries, dependency direction, or layer responsibilities.
---

# Clean Architecture - NOVA Microservicio Autos

## Objetivo

Implementar correctamente la arquitectura **Clean Architecture (Ports & Adapters)** respetando las fronteras entre capas y la dirección de dependencias.

---

## Arquitectura de Capas

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PRESENTATION LAYER                                    │
│                  (Controllers, Services, Modules)                            │
│                                                                              │
│  • Maneja HTTP requests/responses                                            │
│  • Orquesta Use Cases (NO contiene lógica de negocio)                       │
│  • Configura Dependency Injection                                            │
│  • Swagger decorators                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ depends on
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DOMAIN LAYER                                        │
│          (Use Cases, DTOs, Repository/DataSource Interfaces)                 │
│                                                                              │
│  • Lógica de negocio PURA                                                   │
│  • NO tiene dependencias de framework (NestJS)                               │
│  • Define interfaces abstractas (Ports)                                      │
│  • DTOs con validación                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ implements
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      INFRASTRUCTURE LAYER                                    │
│         (Repository Impl, DataSource Impl, External Services)                │
│                                                                              │
│  • Implementaciones concretas (Adapters)                                     │
│  • Acceso a base de datos (Prisma)                                          │
│  • Servicios externos                                                        │
│  • Implementa interfaces del Domain                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Reglas de Dependencia (CRÍTICO)

### ✅ PERMITIDO

```
Presentation → Domain
Presentation → Infrastructure
Infrastructure → Domain
```

### ❌ PROHIBIDO

```
Domain → Infrastructure (NUNCA)
Domain → Presentation (NUNCA)
Infrastructure → Presentation (NUNCA)
```

**El Domain Layer NO debe conocer:**

- NestJS decorators (@Injectable, @Module, etc.)
- Prisma directamente
- Frameworks externos
- Implementaciones concretas

---

## Estructura de Módulo

```
src/core/{entity}/
├── index.ts                              → Barrel exports
│
├── domain/                               → 🎯 DOMAIN LAYER (Negocio Puro)
│   ├── index.ts
│   ├── data-sources/
│   │   ├── {entity}.data-sources/
│   │   │   └── index.ts                  → abstract class (PORT)
│   │   └── index.ts
│   ├── repositories/
│   │   ├── {entity}.data-repository/
│   │   │   └── index.ts                  → abstract class (PORT)
│   │   └── index.ts
│   ├── dtos/
│   │   └── {entity}/
│   │       ├── create-{entity}.dto.ts
│   │       ├── update-{entity}.dto.ts
│   │       └── index.ts
│   └── use-case/
│       └── {entity}/
│           ├── create-{entity}.usecase.ts
│           ├── find-all-{entity}.usecase.ts
│           └── index.ts
│
├── infrastructure/                        → 🔧 INFRASTRUCTURE LAYER (Adapters)
│   ├── index.ts
│   ├── data-sources/
│   │   └── {entity}-impl.data-sources/
│   │       ├── {entity}-liverpool-mssql.data-sources.ts
│   │       ├── {entity}-suburbia-mssql.data-sources.ts
│   │       └── index.ts
│   └── repositories/
│       └── {entity}-impl.repository/
│           └── index.ts
│
└── presentation/                          → 🌐 PRESENTATION LAYER
    └── {entity}/
        ├── {entity}.controller.ts
        ├── {entity}.service.ts
        ├── {entity}.module.ts
        └── decorators/
            └── index.ts
```

---

## 1. Domain Layer

### Abstract Data Source (Port)

```typescript
// domain/data-sources/{entity}.data-sources/index.ts

// ⚠️ NO imports de NestJS, Prisma, o frameworks

import { CreateEntityDto } from '../../dtos/{entity}/create-{entity}.dto';
import { UpdateEntityDto } from '../../dtos/{entity}/update-{entity}.dto';
import { EntityDto } from '../../dtos/{entity}/{entity}.dto';

/**
 * Port: Define las operaciones de acceso a datos
 * La implementación concreta (Adapter) va en infrastructure/
 */
export abstract class EntityDataSourcesDto {
  abstract create(dto: CreateEntityDto): Promise<EntityDto>;
  abstract findAll(query: FindAllEntityQuery): Promise<PaginatedEntitiesDto>;
  abstract findOne(dto: EntityIdDto): Promise<EntityDto | null>;
  abstract update(dto: EntityIdDto, data: UpdateEntityDto): Promise<EntityDto>;
  abstract remove(dto: EntityIdDto): Promise<EntityDto>;
}
```

### Abstract Repository (Port)

```typescript
// domain/repositories/{entity}.data-repository/index.ts

// Repository wraps DataSource - same interface
export abstract class EntityRepositoryDto {
  abstract create(dto: CreateEntityDto): Promise<EntityDto>;
  abstract findAll(query: FindAllEntityQuery): Promise<PaginatedEntitiesDto>;
  abstract findOne(dto: EntityIdDto): Promise<EntityDto | null>;
  abstract update(dto: EntityIdDto, data: UpdateEntityDto): Promise<EntityDto>;
  abstract remove(dto: EntityIdDto): Promise<EntityDto>;
}
```

### Use Case (Business Logic)

```typescript
// domain/use-case/{entity}/create-{entity}.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { EntityRepositoryDto } from '../../repositories/{entity}.data-repository';
import { CreateEntityDto } from '../../dtos/{entity}/create-{entity}.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

/**
 * Use Case: Contiene TODA la lógica de negocio
 *
 * Responsabilidades:
 * - Validación de negocio
 * - Transformación de datos
 * - Orquestación de operaciones
 * - Manejo de errores de negocio
 */
export class CreateEntityUseCase implements UseCaseGeneric<CreateEntityDto> {
  constructor(private readonly repository: EntityRepositoryDto) {}

  async execute(dto: CreateEntityDto, provider: ProviderType) {
    // 1. Validación de negocio
    this.validateBusinessRules(dto, provider);

    // 2. Transformación según tenant
    const payload = this.buildPayload(dto, provider);

    // 3. Persistencia
    const data = await this.repository.create(payload);

    // 4. Retorno
    return { data };
  }

  private validateBusinessRules(dto: CreateEntityDto, provider: ProviderType) {
    // Reglas de negocio aquí
  }

  private buildPayload(dto: CreateEntityDto, provider: ProviderType) {
    // Transformación según tenant
    return dto;
  }
}
```

### DTOs (Data Transfer Objects)

```typescript
// domain/dtos/{entity}/create-{entity}.dto.ts

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
} from 'class-validator';

/**
 * DTO: Define la estructura de datos de entrada
 *
 * Responsabilidades:
 * - Definir campos esperados
 * - Validación de tipos con class-validator
 * - Documentación con Swagger
 */
export class CreateEntityDto {
  @ApiProperty({ description: 'Entity name', example: 'Example' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;
}
```

---

## 2. Infrastructure Layer

### DataSource Implementation (Adapter)

```typescript
// infrastructure/data-sources/{entity}-impl.data-sources/{entity}-liverpool-mssql.data-sources.ts

import { PrismaClient } from '.prisma/client-liverpool';
import { EntityDataSourcesDto } from '../../../domain/data-sources/{entity}.data-sources';
import { CustomError } from '@/infrastructure/errors/custom.error';

/**
 * Adapter: Implementación concreta para Liverpool
 *
 * Responsabilidades:
 * - Acceso a base de datos
 * - Queries Prisma
 * - Manejo de errores de BD
 */
export class EntityLiverpoolMsSqlDataSources implements EntityDataSourcesDto {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dto: CreateEntityDto): Promise<EntityDto> {
    try {
      return await this.prisma.entity.create({ data: dto });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw CustomError.badRequest({
          description: 'Registro duplicado.',
        });
      }
      throw error;
    }
  }

  async findAll(query: FindAllEntityQuery): Promise<PaginatedEntitiesDto> {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.entity.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.entity.count(),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ... other methods
}
```

### Repository Implementation (Adapter)

```typescript
// infrastructure/repositories/{entity}-impl.repository/index.ts

import { EntityDataSourcesDto } from '../../../domain/data-sources/{entity}.data-sources';
import { EntityRepositoryDto } from '../../../domain/repositories/{entity}.data-repository';

/**
 * Repository Implementation: Delega al DataSource
 *
 * El Repository es una capa de abstracción que permite:
 * - Cambiar DataSource sin afectar Use Cases
 * - Agregar caching, logging, etc.
 */
export class EntityImplRepository implements EntityRepositoryDto {
  constructor(private readonly dataSource: EntityDataSourcesDto) {}

  async create(dto: CreateEntityDto): Promise<EntityDto> {
    return this.dataSource.create(dto);
  }

  async findAll(query: FindAllEntityQuery): Promise<PaginatedEntitiesDto> {
    return this.dataSource.findAll(query);
  }

  // ... delegate all methods
}
```

---

## 3. Presentation Layer

### Service (Orchestration ONLY)

```typescript
// presentation/{entity}/{entity}.service.ts

import { Injectable, Inject } from '@nestjs/common';
import { EntityRepositoryDto } from '../../domain/repositories/{entity}.data-repository';
import { CreateEntityDto } from '../../domain/dtos/{entity}/create-{entity}.dto';
import { ProviderType } from '@/shared';
import { CreateEntityUseCase } from '../../domain/use-case/{entity}';

/**
 * Service: SOLO orquestación
 *
 * ❌ NO debe contener lógica de negocio
 * ✅ Solo instancia y ejecuta Use Cases
 */
@Injectable()
export class EntityService {
  constructor(
    @Inject('EntityRepository')
    private readonly repository: EntityRepositoryDto,
  ) {}

  // ✅ CORRECTO: Solo orquestación
  async create(dto: CreateEntityDto, provider: ProviderType) {
    return new CreateEntityUseCase(this.repository).execute(dto, provider);
  }

  // ❌ INCORRECTO: Lógica de negocio en Service
  // async create(dto: CreateEntityDto, provider: ProviderType) {
  //   if (dto.price < 0) throw new Error('Invalid price'); // ❌ Esto va en UseCase
  //   return this.repository.create(dto);
  // }
}
```

### Controller (HTTP Interface)

```typescript
// presentation/{entity}/{entity}.controller.ts

import { Controller, Post, Body, Get, Query, Param } from '@nestjs/common';
import { EntityService } from './{entity}.service';
import { CreateEntityDto } from '../../domain/dtos/{entity}/create-{entity}.dto';
import { ApiRuleResponse } from '@/shared/rules/api.rule.response';
import { AuthContextService } from '@/infrastructure/auth';
import { ApiEntityController, ApiCreateEntity } from './decorators';

/**
 * Controller: Manejo HTTP
 *
 * Responsabilidades:
 * - Recibir requests HTTP
 * - Validar con DTOs (automático via pipes)
 * - Llamar Service
 * - Formatear response con ApiRuleResponse
 */
@ApiEntityController()
@Controller('entities')
export class EntityController {
  constructor(
    private readonly service: EntityService,
    private readonly authContext: AuthContextService,
  ) {}

  @Post()
  @ApiCreateEntity()
  async create(@Body() dto: CreateEntityDto) {
    const result = await this.service.create(dto, this.authContext.tenant);
    return ApiRuleResponse.success(result);
  }
}
```

### Module (Dependency Injection)

```typescript
// presentation/{entity}/{entity}.module.ts

import { Module, Scope } from '@nestjs/common';
import { EntityService } from './{entity}.service';
import { EntityController } from './{entity}.controller';
import { EntityImplRepository } from '../../infrastructure/repositories/{entity}-impl.repository';
import {
  EntityLiverpoolMsSqlDataSources,
  EntitySuburbiaMsSqlDataSources,
} from '../../infrastructure/data-sources/{entity}-impl.data-sources';
import { PrismaMultiTenantService } from '@/infrastructure/prisma/prisma-multi-tenant.service';
import { AuthContextService } from '@/infrastructure/auth';

/**
 * Module: Configuración de DI
 *
 * Wiring de Ports & Adapters:
 * - Define qué Adapter implementa cada Port
 * - Configura scope de providers
 * - Factory pattern para multi-tenant
 */
@Module({
  controllers: [EntityController],
  providers: [
    EntityService,
    {
      provide: 'EntityRepository', // Port name
      scope: Scope.REQUEST,
      useFactory: (prisma, auth) => {
        const dataSource =
          auth.tenant === 'liverpool'
            ? new EntityLiverpoolMsSqlDataSources(prisma.liverpool)
            : new EntitySuburbiaMsSqlDataSources(prisma.suburbia);
        return new EntityImplRepository(dataSource); // Adapter
      },
      inject: [PrismaMultiTenantService, AuthContextService],
    },
  ],
})
export class EntityModule {}
```

---

## 4. Flujo de Datos

```
HTTP Request
     │
     ▼
┌─────────────────┐
│   Controller    │  ← Presentation Layer
│   (HTTP)        │
└────────┬────────┘
         │ dto, tenant
         ▼
┌─────────────────┐
│    Service      │  ← Presentation Layer (orchestration)
│ (orchestration) │
└────────┬────────┘
         │ instantiate & execute
         ▼
┌─────────────────┐
│    Use Case     │  ← Domain Layer (business logic)
│ (business)      │
└────────┬────────┘
         │ call interface
         ▼
┌─────────────────┐
│   Repository    │  ← Domain Layer (interface/port)
│   (interface)   │
└────────┬────────┘
         │ implemented by
         ▼
┌─────────────────┐
│ Repository Impl │  ← Infrastructure Layer (adapter)
│   (adapter)     │
└────────┬────────┘
         │ delegates to
         ▼
┌─────────────────┐
│   DataSource    │  ← Infrastructure Layer (adapter)
│   (Prisma)      │
└────────┬────────┘
         │
         ▼
    Database
```

---

## 5. Checklist de Clean Architecture

- [ ] Domain Layer NO importa de Infrastructure
- [ ] Domain Layer NO tiene decorators de NestJS
- [ ] Use Cases contienen TODA la lógica de negocio
- [ ] Services SOLO orquestan Use Cases
- [ ] Interfaces abstractas definidas en Domain
- [ ] Implementaciones concretas en Infrastructure
- [ ] Module configura DI correctamente
- [ ] Dependencias apuntan hacia el Domain
