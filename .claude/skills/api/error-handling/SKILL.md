---
name: error-handling
description: This skill should be used when the user asks about "error handling", "CustomError", "exception handling", "API errors", "error responses", or mentions error messages, status codes, Prisma errors, validation errors, or exception filters.
---

# Error Handling - NOVA Microservicio Autos

## Objetivo

Implementar correctamente el manejo de errores usando `CustomError` para respuestas consistentes y mensajes claros.

---

## Arquitectura de Errores

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ERROR FLOW                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
     ┌──────────────────────────────┼──────────────────────────────┐
     │                              │                              │
     ▼                              ▼                              ▼
┌──────────────┐           ┌──────────────┐           ┌──────────────┐
│  Validation  │           │   Business   │           │   Database   │
│    Error     │           │    Error     │           │    Error     │
│              │           │              │           │              │
│ class-valid. │           │  Use Case    │           │   Prisma     │
└──────┬───────┘           └──────┬───────┘           └──────┬───────┘
       │                          │                          │
       │                          │                          │
       ▼                          ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CustomError.xxx()                                    │
│                                                                              │
│  .badRequest()  .notFound()  .unauthorized()  .forbidden()  .internal()     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GlobalExceptionFilter                                   │
│                   (Transforms to HTTP Response)                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        HTTP Response                                         │
│  { status: 400, message: { description: 'Error message' }, data: null }     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. CustomError Class

### Location

```
src/infrastructure/errors/custom.error.ts
```

### Usage Pattern

```typescript
import { CustomError } from '@/infrastructure/errors/custom.error';

// Bad Request (400) - Invalid input
throw CustomError.badRequest({
  description: 'El VIN proporcionado no es válido.',
});

// Not Found (404) - Resource doesn't exist
throw CustomError.notFound({
  description: 'El auto no fue encontrado.',
});

// Unauthorized (401) - Authentication required
throw CustomError.unauthorized({
  description: 'Token de autenticación inválido.',
});

// Forbidden (403) - No permission
throw CustomError.forbidden({
  description: 'No tienes permiso para realizar esta acción.',
});

// Conflict (409) - Resource conflict
throw CustomError.conflict({
  description: 'Ya existe un registro con ese VIN.',
});

// Internal (500) - Server error
throw CustomError.internal({
  description: 'Error interno del servidor.',
});
```

### FeedbackContentProps Interface

```typescript
// src/shared/types/message.type.ts

export interface FeedbackContentProps {
  description?: string;
  status?: 'error' | 'warning' | 'info' | 'success';
  // Additional fields as needed
}
```

---

## 2. Error Handling by Layer

### Use Case Layer (Business Errors)

```typescript
// domain/use-case/entity/create-entity.usecase.ts

export class CreateEntityUseCase implements UseCaseGeneric<CreateEntityDto> {
  constructor(private readonly repository: EntityRepositoryDto) {}

  async execute(dto: CreateEntityDto, provider: ProviderType) {
    // Validation error
    if (!dto.name || dto.name.length < 2) {
      throw CustomError.badRequest({
        description: 'El nombre debe tener al menos 2 caracteres.',
      });
    }

    // Business rule validation
    if (provider === 'suburbia' && dto.vin) {
      throw CustomError.badRequest({
        description: 'El campo VIN no está disponible para Suburbia.',
      });
    }

    // Not found error
    const existing = await this.repository.findOne({ id: dto.parentId });
    if (!existing) {
      throw CustomError.notFound({
        description: 'El registro padre no existe.',
      });
    }

    return await this.repository.create(dto);
  }
}
```

### DataSource Layer (Database Errors)

```typescript
// infrastructure/data-sources/entity-impl.data-sources/entity-liverpool-mssql.data-sources.ts

export class EntityLiverpoolMsSqlDataSources implements EntityDataSourcesDto {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dto: CreateEntityDto): Promise<EntityDto> {
    try {
      return await this.prisma.entity.create({ data: dto });
    } catch (error: any) {
      // Unique constraint violation
      if (error?.code === 'P2002') {
        const field = error.meta?.target?.[0] || 'campo';
        throw CustomError.badRequest({
          description: `El ${field} ya existe en la base de datos.`,
        });
      }

      // Record not found (for updates/deletes)
      if (error?.code === 'P2025') {
        throw CustomError.notFound({
          description: 'El registro no fue encontrado.',
        });
      }

      // Foreign key constraint
      if (error?.code === 'P2003') {
        throw CustomError.badRequest({
          description: 'El registro relacionado no existe.',
        });
      }

      // Re-throw unknown errors
      throw error;
    }
  }

  async update(dto: EntityIdDto, data: UpdateEntityDto): Promise<EntityDto> {
    try {
      return await this.prisma.entity.update({
        where: { id: dto.id },
        data,
      });
    } catch (error: any) {
      if (error?.code === 'P2025') {
        throw CustomError.notFound({
          description: `El auto con ID "${dto.id}" no existe.`,
        });
      }
      throw error;
    }
  }

  async remove(dto: EntityIdDto): Promise<EntityDto> {
    try {
      return await this.prisma.entity.delete({
        where: { id: dto.id },
      });
    } catch (error: any) {
      if (error?.code === 'P2025') {
        throw CustomError.notFound({
          description: `El auto con ID "${dto.id}" no existe.`,
        });
      }
      throw error;
    }
  }
}
```

---

## 3. Prisma Error Codes Reference

| Code  | Description                 | CustomError     |
| ----- | --------------------------- | --------------- |
| P2002 | Unique constraint violation | `.badRequest()` |
| P2025 | Record not found            | `.notFound()`   |
| P2003 | Foreign key constraint      | `.badRequest()` |
| P2014 | Relation violation          | `.badRequest()` |
| P2016 | Query interpretation error  | `.internal()`   |

### Complete Prisma Error Handler

```typescript
// utils/prisma-error-handler.ts

import { CustomError } from '@/infrastructure/errors/custom.error';

export function handlePrismaError(error: any, context?: string): never {
  const errorMap: Record<string, () => never> = {
    P2002: () => {
      const field = error.meta?.target?.[0] || 'campo';
      throw CustomError.badRequest({
        description: `El ${field} ya existe.`,
      });
    },
    P2025: () => {
      throw CustomError.notFound({
        description: context
          ? `${context} no encontrado.`
          : 'Registro no encontrado.',
      });
    },
    P2003: () => {
      throw CustomError.badRequest({
        description: 'El registro relacionado no existe.',
      });
    },
  };

  const handler = errorMap[error?.code];
  if (handler) {
    handler();
  }

  // Unknown error - re-throw
  throw error;
}

// Usage
try {
  return await this.prisma.entity.create({ data });
} catch (error) {
  handlePrismaError(error, 'Auto');
}
```

---

## 4. Validation Errors (class-validator)

### DTO with Validation

```typescript
// domain/dtos/entity/create-entity.dto.ts

import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsOptional,
  Length,
} from 'class-validator';

export class CreateEntityDto {
  @ApiProperty({ description: 'Brand name', example: 'Toyota' })
  @IsString({ message: 'La marca debe ser texto.' })
  @IsNotEmpty({ message: 'La marca es requerida.' })
  @Length(2, 50, { message: 'La marca debe tener entre 2 y 50 caracteres.' })
  brand: string;

  @ApiProperty({ description: 'Year', example: 2024 })
  @IsInt({ message: 'El año debe ser un número entero.' })
  @Min(1900, { message: 'El año debe ser mayor a 1900.' })
  @Max(2100, { message: 'El año debe ser menor a 2100.' })
  year: number;
}
```

### ValidationPipe Configuration

```typescript
// main/index.ts

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true, // Remove non-whitelisted properties
    forbidNonWhitelisted: true, // Throw error on extra properties
    transform: true, // Transform to DTO class instances
    transformOptions: {
      enableImplicitConversion: true,
    },
  }),
);
```

---

## 5. Response Format

### Success Response

```typescript
import { ApiRuleResponse } from '@/shared/rules/api.rule.response';

// Controller
@Post()
async create(@Body() dto: CreateEntityDto) {
  const result = await this.service.create(dto, this.authContext.tenant);
  return ApiRuleResponse.success(result);
}

// Response format
{
  "status": "OK",
  "data": {
    "id": "clxxxxxxxxxx",
    "brand": "Toyota",
    "model": "Corolla"
  }
}
```

### Error Response

```json
{
  "statusCode": 400,
  "message": {
    "description": "El VIN ya existe en la base de datos.",
    "status": "error"
  },
  "error": "Bad Request"
}
```

---

## 6. Error Handling Patterns

### Try-Catch Pattern (DataSource)

```typescript
async create(dto: CreateEntityDto): Promise<EntityDto> {
  try {
    return await this.prisma.entity.create({ data: dto });
  } catch (error: any) {
    // Handle known errors
    if (error?.code === 'P2002') {
      throw CustomError.badRequest({
        description: `El VIN "${dto.vin}" ya existe.`,
      });
    }
    // Re-throw unknown errors to global handler
    throw error;
  }
}
```

### Validation Pattern (Use Case)

```typescript
async execute(dto: CreateEntityDto, provider: ProviderType) {
  // Validate business rules before database operations
  this.validateTenantFields(dto, provider);

  // Proceed with operation
  const data = await this.repository.create(dto);
  return { data };
}

private validateTenantFields(dto: CreateEntityDto, provider: ProviderType) {
  const liverpoolFields = ['vin', 'mileage', 'interiorColor', 'hasWarranty'];
  const suburbiaFields = ['discount', 'category', 'isFeatured'];

  if (provider === 'suburbia') {
    const invalidFields = liverpoolFields.filter(f => dto[f] !== undefined);
    if (invalidFields.length) {
      throw CustomError.badRequest({
        description: `Los campos [${invalidFields.join(', ')}] no están disponibles para Suburbia.`,
      });
    }
  }

  if (provider === 'liverpool') {
    const invalidFields = suburbiaFields.filter(f => dto[f] !== undefined);
    if (invalidFields.length) {
      throw CustomError.badRequest({
        description: `Los campos [${invalidFields.join(', ')}] no están disponibles para Liverpool.`,
      });
    }
  }
}
```

---

## 7. Checklist

- [ ] Use `CustomError` for all business errors
- [ ] Handle Prisma error codes in DataSource
- [ ] Provide clear, user-friendly error messages
- [ ] Validate business rules in Use Cases
- [ ] Use class-validator for DTO validation
- [ ] Never expose stack traces or internal details
- [ ] Log errors for debugging (but don't expose)
- [ ] Test error scenarios for both tenants
