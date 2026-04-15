---
name: dto-validation
description: This skill should be used when the user asks about "DTO validation", "class-validator", "input validation", "request validation", or mentions validating API inputs, decorators, transformation, or data validation patterns.
---

# DTO Validation - NOVA Microservicio Autos

## Objetivo

Implementar validación robusta de datos de entrada usando `class-validator` y `class-transformer` siguiendo las convenciones del proyecto.

---

## Arquitectura de Validación

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VALIDATION FLOW                                      │
└─────────────────────────────────────────────────────────────────────────────┘

HTTP Request Body
       │
       ▼
┌──────────────────┐
│  ValidationPipe  │  ← Global pipe configured in main.ts
│  (NestJS)        │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ class-transformer│  ← Transforms plain object to class instance
│                  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  class-validator │  ← Validates decorators on DTO properties
│                  │
└────────┬─────────┘
         │
         ├── ✅ Valid → Continue to Controller
         │
         └── ❌ Invalid → 400 Bad Request with error details
```

---

## 1. ValidationPipe Configuration

```typescript
// src/main/index.ts

import { ValidationPipe } from '@nestjs/common';

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true, // Strip properties not in DTO
    forbidNonWhitelisted: true, // Error on extra properties
    transform: true, // Transform to DTO class instance
    transformOptions: {
      enableImplicitConversion: true, // Auto-convert types
    },
  }),
);
```

---

## 2. Prisma Type → Validator Mapping

| Prisma Type          | TypeScript | Validators                             | Example                 |
| -------------------- | ---------- | -------------------------------------- | ----------------------- |
| `String`             | `string`   | `@IsString() @IsNotEmpty()`            | `brand: string`         |
| `String?`            | `string?`  | `@IsOptional() @IsString()`            | `description?: string`  |
| `String @unique`     | `string`   | `@IsString() @IsNotEmpty()`            | `vin: string`           |
| `Int`                | `number`   | `@IsInt()`                             | `year: number`          |
| `Int?`               | `number?`  | `@IsOptional() @IsInt()`               | `mileage?: number`      |
| `Float`              | `number`   | `@IsNumber()`                          | `rating: number`        |
| `Decimal`            | `number`   | `@IsNumber({ maxDecimalPlaces: 2 })`   | `price: number`         |
| `Boolean`            | `boolean`  | `@IsBoolean()`                         | `isActive: boolean`     |
| `Boolean @default()` | `boolean?` | `@IsOptional() @IsBoolean()`           | `isAvailable?: boolean` |
| `DateTime`           | `Date`     | `@IsISO8601() @Type(() => Date)`       | `date: Date`            |
| `DateTime?`          | `Date?`    | `@IsOptional() @IsISO8601()`           | `deletedAt?: Date`      |
| `Enum`               | `EnumType` | `@IsEnum(EnumType)`                    | `status: Status`        |
| `String[]`           | `string[]` | `@IsArray() @IsString({ each: true })` | `tags: string[]`        |

---

## 3. DTO Templates

### CreateDto

```typescript
// domain/dtos/{entity}/create-{entity}.dto.ts

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsNumber,
  IsBoolean,
  Min,
  Max,
  Length,
  IsISO8601,
  IsEnum,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class CreateCarDto {
  // Required string
  @ApiProperty({ description: 'Car brand', example: 'Toyota' })
  @IsString({ message: 'La marca debe ser texto.' })
  @IsNotEmpty({ message: 'La marca es requerida.' })
  @Length(2, 50, { message: 'La marca debe tener entre 2 y 50 caracteres.' })
  brand: string;

  // Required string
  @ApiProperty({ description: 'Car model', example: 'Corolla' })
  @IsString({ message: 'El modelo debe ser texto.' })
  @IsNotEmpty({ message: 'El modelo es requerido.' })
  model: string;

  // Required integer with range
  @ApiProperty({ description: 'Year', example: 2024 })
  @IsInt({ message: 'El año debe ser un número entero.' })
  @Min(1900, { message: 'El año debe ser mayor a 1900.' })
  @Max(2100, { message: 'El año debe ser menor a 2100.' })
  year: number;

  // Optional string
  @ApiPropertyOptional({ description: 'Color', example: 'Red' })
  @IsOptional()
  @IsString({ message: 'El color debe ser texto.' })
  color?: string;

  // Optional decimal
  @ApiPropertyOptional({ description: 'Price', example: 25000.99 })
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El precio debe ser un número con máximo 2 decimales.' },
  )
  @Min(0, { message: 'El precio no puede ser negativo.' })
  price?: number;

  // Optional boolean with default
  @ApiPropertyOptional({ description: 'Is available', default: true })
  @IsOptional()
  @IsBoolean({ message: 'isAvailable debe ser true o false.' })
  isAvailable?: boolean;

  // Optional text
  @ApiPropertyOptional({ description: 'Description' })
  @IsOptional()
  @IsString({ message: 'La descripción debe ser texto.' })
  @Length(0, 1000, {
    message: 'La descripción no puede exceder 1000 caracteres.',
  })
  description?: string;

  // ============ LIVERPOOL-ONLY FIELDS ============

  @ApiPropertyOptional({
    description: 'Mileage (Liverpool only)',
    example: 50000,
  })
  @IsOptional()
  @IsInt({ message: 'El kilometraje debe ser un número entero.' })
  @Min(0, { message: 'El kilometraje no puede ser negativo.' })
  mileage?: number;

  @ApiPropertyOptional({
    description: 'VIN (Liverpool only)',
    example: '1HGBH41JXMN109186',
  })
  @IsOptional()
  @IsString({ message: 'El VIN debe ser texto.' })
  @Length(17, 17, { message: 'El VIN debe tener exactamente 17 caracteres.' })
  vin?: string;

  @ApiPropertyOptional({ description: 'Interior color (Liverpool only)' })
  @IsOptional()
  @IsString()
  interiorColor?: string;

  @ApiPropertyOptional({
    description: 'Has warranty (Liverpool only)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  hasWarranty?: boolean;

  // ============ SUBURBIA-ONLY FIELDS ============

  @ApiPropertyOptional({
    description: 'Discount percentage (Suburbia only)',
    example: 10.5,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discount?: number;

  @ApiPropertyOptional({ description: 'Category (Suburbia only)' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({
    description: 'Is featured (Suburbia only)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;
}
```

### UpdateDto (Using PartialType)

```typescript
// domain/dtos/{entity}/update-{entity}.dto.ts

import { PartialType } from '@nestjs/swagger';
import { CreateCarDto } from './create-car.dto';

// All fields become optional
export class UpdateCarDto extends PartialType(CreateCarDto) {}
```

### FindAllQuery

```typescript
// domain/dtos/{entity}/find-all-{entity}.query.ts

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsInt,
  Min,
  IsString,
  IsBoolean,
  IsNumber,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class FindAllCarQuery {
  // Pagination
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit: number = 10;

  // String filters
  @ApiPropertyOptional({ description: 'Filter by brand' })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({ description: 'Filter by model' })
  @IsOptional()
  @IsString()
  model?: string;

  // Number filter
  @ApiPropertyOptional({ description: 'Filter by year' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;

  // Range filters
  @ApiPropertyOptional({ description: 'Minimum price' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Maximum price' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxPrice?: number;

  // Boolean filter (transform from query string)
  @ApiPropertyOptional({ description: 'Filter by availability' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isAvailable?: boolean;
}
```

### IdDto (Params)

```typescript
// domain/dtos/{entity}/{entity}-id.dto.ts

import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class CarIdDto {
  @ApiProperty({ description: 'Car ID', example: 'clxxxxxxxxxx' })
  @IsString({ message: 'El ID debe ser texto.' })
  @IsNotEmpty({ message: 'El ID es requerido.' })
  id: string;
}
```

### ResponseDto

```typescript
// domain/dtos/{entity}/{entity}.dto.ts

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CarDto {
  @ApiProperty({ example: 'clxxxxxxxxxx' })
  id: string;

  @ApiProperty({ example: 'Toyota' })
  brand: string;

  @ApiProperty({ example: 'Corolla' })
  model: string;

  @ApiProperty({ example: 2024 })
  year: number;

  @ApiPropertyOptional({ example: 'Red' })
  color?: string;

  @ApiPropertyOptional({ example: 25000.99 })
  price?: number;

  @ApiProperty({ example: true })
  isAvailable: boolean;

  @ApiPropertyOptional()
  description?: string;

  // Liverpool-only
  @ApiPropertyOptional()
  mileage?: number;

  @ApiPropertyOptional()
  vin?: string;

  // Suburbia-only
  @ApiPropertyOptional()
  discount?: number;

  @ApiPropertyOptional()
  category?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
```

### PaginatedDto

```typescript
// domain/dtos/{entity}/paginated-{entity}s.dto.ts

import { ApiProperty } from '@nestjs/swagger';
import { CarDto } from './car.dto';

export class PaginatedCarsDto {
  @ApiProperty({ type: [CarDto] })
  data: CarDto[];

  @ApiProperty({ example: 100 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 10 })
  totalPages: number;
}
```

---

## 4. Custom Validators

### Custom Decorator Example

```typescript
// shared/decorators/class-validator/is-valid-vin.decorator.ts

import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ async: false })
export class IsValidVinConstraint implements ValidatorConstraintInterface {
  validate(vin: string) {
    if (!vin) return true; // Let @IsOptional handle this

    // VIN must be 17 characters, alphanumeric (no I, O, Q)
    const vinRegex = /^[A-HJ-NPR-Z0-9]{17}$/;
    return vinRegex.test(vin);
  }

  defaultMessage() {
    return 'VIN inválido. Debe tener 17 caracteres alfanuméricos.';
  }
}

export function IsValidVin(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidVinConstraint,
    });
  };
}

// Usage
@IsOptional()
@IsValidVin()
vin?: string;
```

---

## 5. Transformation Examples

### Transform Query Strings

```typescript
// Boolean from query string
@Transform(({ value }) => value === 'true')
@IsBoolean()
isActive?: boolean;

// Number from query string
@Type(() => Number)
@IsInt()
year?: number;

// Date from ISO string
@Type(() => Date)
@IsDate()
createdAt?: Date;

// Trim whitespace
@Transform(({ value }) => value?.trim())
@IsString()
name: string;

// Lowercase
@Transform(({ value }) => value?.toLowerCase())
@IsEmail()
email: string;
```

---

## 6. Error Messages

### Custom Messages

```typescript
@IsString({ message: 'El campo $property debe ser texto.' })
@IsNotEmpty({ message: 'El campo $property es requerido.' })
@Length(2, 50, { message: '$property debe tener entre $constraint1 y $constraint2 caracteres.' })
@Min(0, { message: '$property debe ser mayor o igual a $constraint1.' })
```

### Error Response Format

```json
{
  "statusCode": 400,
  "message": ["brand must be a string", "year must be an integer number"],
  "error": "Bad Request"
}
```

---

## 7. Testing DTOs

```typescript
// domain/dtos/car/create-car.dto.spec.ts

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCarDto } from './create-car.dto';

describe('CreateCarDto', () => {
  it('should pass with valid data', async () => {
    const dto = plainToInstance(CreateCarDto, {
      brand: 'Toyota',
      model: 'Corolla',
      year: 2024,
    });
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should fail without required fields', async () => {
    const dto = plainToInstance(CreateCarDto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should fail with invalid year', async () => {
    const dto = plainToInstance(CreateCarDto, {
      brand: 'Toyota',
      model: 'Corolla',
      year: 1800, // Too old
    });
    const errors = await validate(dto);
    expect(errors.some(e => e.property === 'year')).toBe(true);
  });

  it('should accept optional fields', async () => {
    const dto = plainToInstance(CreateCarDto, {
      brand: 'Toyota',
      model: 'Corolla',
      year: 2024,
      color: 'Red',
      price: 25000.99,
    });
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });
});
```

---

## 8. Checklist

- [ ] All DTOs have proper validation decorators
- [ ] Swagger decorators for documentation
- [ ] Custom error messages in Spanish
- [ ] PartialType for UpdateDto
- [ ] Query transformations with @Type()
- [ ] Boolean transforms from query strings
- [ ] Pagination defaults in FindAllQuery
- [ ] Tenant-specific fields documented
- [ ] Tests for validation logic
