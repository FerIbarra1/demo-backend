---
description: Generate complete CRUD module from Prisma model for NOVA Microservicio Autos
model: claude-sonnet-4-5
---

# Create New Module - NOVA Microservicio Autos

Generate a complete CRUD module following Clean Architecture and multi-tenant patterns.

## Model/Requirements

$ARGUMENTS

## Generation Process

### 1. Parse the Prisma Model

Extract:

- Model name → `{{Model}}` (PascalCase)
- Model name → `{{kebabModel}}` (kebab-case)
- Model name → `{{model}}` (camelCase)
- Fields with types and constraints
- Tenant-specific fields (if any)

### 2. File Structure to Generate

```
src/core/{{kebabModel}}/
├── index.ts
├── domain/
│   ├── index.ts
│   ├── data-sources/
│   │   ├── {{kebabModel}}.data-sources/
│   │   │   └── index.ts
│   │   └── index.ts
│   ├── dtos/
│   │   └── {{kebabModel}}/
│   │       ├── create-{{kebabModel}}.dto.ts
│   │       ├── update-{{kebabModel}}.dto.ts
│   │       ├── find-all-{{kebabModel}}.query.ts
│   │       ├── {{kebabModel}}-id.dto.ts
│   │       ├── {{kebabModel}}.dto.ts
│   │       ├── paginated-{{kebabModel}}s.dto.ts
│   │       └── index.ts
│   ├── repositories/
│   │   ├── {{kebabModel}}.data-repository/
│   │   │   └── index.ts
│   │   └── index.ts
│   └── use-case/
│       └── {{kebabModel}}/
│           ├── create-{{kebabModel}}.usecase.ts
│           ├── find-all-{{kebabModel}}.usecase.ts
│           ├── find-one-{{kebabModel}}.usecase.ts
│           ├── update-{{kebabModel}}.usecase.ts
│           ├── remove-{{kebabModel}}.usecase.ts
│           └── index.ts
├── infrastructure/
│   ├── index.ts
│   ├── data-sources/
│   │   └── {{kebabModel}}-impl.data-sources/
│   │       ├── {{kebabModel}}-liverpool-mssql.data-sources.ts
│   │       ├── {{kebabModel}}-suburbia-mssql.data-sources.ts
│   │       └── index.ts
│   └── repositories/
│       └── {{kebabModel}}-impl.repository/
│           └── index.ts
└── presentation/
    └── {{kebabModel}}/
        ├── {{kebabModel}}.controller.ts
        ├── {{kebabModel}}.service.ts
        ├── {{kebabModel}}.module.ts
        └── decorators/
            └── index.ts
```

### 3. Key Patterns to Follow

**Use Case Pattern:**

```typescript
export class Create{{Model}}UseCase implements UseCaseGeneric<Create{{Model}}Dto> {
  constructor(private readonly repository: {{Model}}RepositoryDto) {}
  async execute(dto: Create{{Model}}Dto, provider: ProviderType) {
    const data = await this.repository.create(dto);
    return { data };
  }
}
```

**Service (Orchestration Only):**

```typescript
async create(dto: Create{{Model}}Dto, provider: ProviderType) {
  return new Create{{Model}}UseCase(this.repository).execute(dto, provider);
}
```

**Multi-Tenant Factory:**

```typescript
{
  provide: '{{Model}}Repository',
  scope: Scope.REQUEST,
  useFactory: (prismaMultiTenant, authContext) => {
    const tenant = authContext.tenant;
    const dataSourceBuilder = {
      liverpool: () => new {{Model}}LiverpoolMsSqlDataSources(prismaMultiTenant.liverpool),
      suburbia: () => new {{Model}}SuburbiaMsSqlDataSources(prismaMultiTenant.suburbia),
    };
    return new {{Model}}ImplRepository(dataSourceBuilder[tenant]());
  },
  inject: [PrismaMultiTenantService, AuthContextService],
}
```

### 4. DTO Validation Mapping

| Prisma Type | Validators                           |
| ----------- | ------------------------------------ |
| String      | `@IsString()`                        |
| String?     | `@IsOptional() @IsString()`          |
| Int         | `@IsInt()`                           |
| Boolean     | `@IsBoolean()`                       |
| DateTime    | `@IsISO8601()`                       |
| Decimal     | `@IsNumber({ maxDecimalPlaces: 2 })` |
| @unique     | Handle P2002 in DataSource           |

### 5. Post-Generation Steps

```bash
# 1. Update Prisma schemas if not already done
# prisma/liverpool/schema.prisma
# prisma/suburbia/schema.prisma

# 2. Generate Prisma clients
npm run prisma:push:all
npm run prisma:generate:all

# 3. Register in CoreModule
# src/core/core.module.ts

# 4. Test
npm run start:dev
```

## Reference Implementation

Use `src/core/car/` as the reference for all patterns.

## Generate ALL files needed for a complete, working module.
