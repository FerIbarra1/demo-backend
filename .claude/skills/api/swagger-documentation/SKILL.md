---
name: swagger-documentation
description: This skill should be used when the user asks about "Swagger", "OpenAPI", "API documentation", "API decorators", or mentions documenting endpoints, API schemas, or Swagger UI configuration.
---

# Swagger/OpenAPI Documentation - NOVA Microservicio Autos

## Objetivo

Implementar documentación de API completa y clara usando Swagger/OpenAPI decorators siguiendo las convenciones del proyecto.

---

## Arquitectura de Documentación

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SWAGGER DOCUMENTATION                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                              Controller                                       │
│  @ApiTags('🚗 Cars - Car Management')                                        │
│  @Controller('cars')                                                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  @Post()                                                                     │
│  @ApiOperation({ summary: 'Create a new car' })                             │
│  @ApiResponse({ status: 201, description: 'Car created', type: CarDto })    │
│  @ApiResponse({ status: 400, description: 'Validation error' })             │
│  @ApiBody({ type: CreateCarDto })                                           │
│  create(@Body() dto: CreateCarDto)                                          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Swagger UI                                         │
│                        http://localhost:3000/api                             │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ 🚗 Cars - Car Management                                               │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │ POST   /cars        Create a new car                                   │ │
│  │ GET    /cars        Get all cars with pagination                       │ │
│  │ GET    /cars/{id}   Get car by ID                                      │ │
│  │ PATCH  /cars/{id}   Update car                                         │ │
│  │ DELETE /cars/{id}   Delete car                                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Swagger Setup

### Main Configuration

```typescript
// src/main/index.ts

import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(MainModule);

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('NOVA Microservicio Autos')
    .setDescription(
      'API para gestión de autos multi-tenant (Liverpool/Suburbia)',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('🚗 Cars - Car Management', 'Endpoints para gestión de autos')
    .addTag('📋 Audit Log', 'Endpoints para consulta de logs de auditoría')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  await app.listen(3000);
}
```

---

## 2. Controller Decorators

### Decorator Pattern (Recommended)

```typescript
// presentation/{entity}/decorators/index.ts

import { applyDecorators } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CreateCarDto } from '../../../domain/dtos/car/create-car.dto';
import { UpdateCarDto } from '../../../domain/dtos/car/update-car.dto';
import { CarDto } from '../../../domain/dtos/car/car.dto';
import { PaginatedCarsDto } from '../../../domain/dtos/car/paginated-cars.dto';

// Controller-level decorator
export const ApiCarController = () =>
  applyDecorators(ApiTags('🚗 Cars - Car Management'), ApiBearerAuth());

// Create endpoint
export const ApiCreateCar = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Create a new car',
      description:
        'Creates a new car in the tenant database. Liverpool supports VIN and mileage fields, Suburbia supports discount and category.',
    }),
    ApiBody({ type: CreateCarDto }),
    ApiResponse({
      status: 201,
      description: 'Car created successfully',
      type: CarDto,
    }),
    ApiResponse({
      status: 400,
      description: 'Validation error or duplicate VIN',
    }),
    ApiResponse({
      status: 401,
      description: 'Unauthorized - Invalid or missing token',
    }),
  );

// Find all endpoint
export const ApiFindAllCars = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Get all cars with pagination',
      description: 'Returns a paginated list of cars with optional filters.',
    }),
    ApiQuery({ name: 'page', required: false, type: Number, example: 1 }),
    ApiQuery({ name: 'limit', required: false, type: Number, example: 10 }),
    ApiQuery({ name: 'brand', required: false, type: String }),
    ApiQuery({ name: 'model', required: false, type: String }),
    ApiQuery({ name: 'year', required: false, type: Number }),
    ApiQuery({ name: 'minPrice', required: false, type: Number }),
    ApiQuery({ name: 'maxPrice', required: false, type: Number }),
    ApiQuery({ name: 'isAvailable', required: false, type: Boolean }),
    ApiResponse({
      status: 200,
      description: 'List of cars',
      type: PaginatedCarsDto,
    }),
  );

// Find one endpoint
export const ApiFindOneCar = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Get car by ID',
      description: 'Returns a single car by its ID.',
    }),
    ApiParam({ name: 'id', description: 'Car ID', example: 'clxxxxxxxxxx' }),
    ApiResponse({
      status: 200,
      description: 'Car found',
      type: CarDto,
    }),
    ApiResponse({
      status: 404,
      description: 'Car not found',
    }),
  );

// Update endpoint
export const ApiUpdateCar = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Update car',
      description: 'Updates an existing car. All fields are optional.',
    }),
    ApiParam({ name: 'id', description: 'Car ID', example: 'clxxxxxxxxxx' }),
    ApiBody({ type: UpdateCarDto }),
    ApiResponse({
      status: 200,
      description: 'Car updated',
      type: CarDto,
    }),
    ApiResponse({
      status: 404,
      description: 'Car not found',
    }),
  );

// Remove endpoint
export const ApiRemoveCar = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Delete car',
      description: 'Permanently deletes a car.',
    }),
    ApiParam({ name: 'id', description: 'Car ID', example: 'clxxxxxxxxxx' }),
    ApiResponse({
      status: 200,
      description: 'Car deleted',
      type: CarDto,
    }),
    ApiResponse({
      status: 404,
      description: 'Car not found',
    }),
  );
```

### Using Decorators in Controller

```typescript
// presentation/{entity}/{entity}.controller.ts

import {
  ApiCarController,
  ApiCreateCar,
  ApiFindAllCars,
  ApiFindOneCar,
  ApiUpdateCar,
  ApiRemoveCar,
} from './decorators';

@ApiCarController()  // Applies ApiTags + ApiBearerAuth
@Controller('cars')
export class CarController {
  @Post()
  @ApiCreateCar()
  async create(@Body() dto: CreateCarDto) { ... }

  @Get()
  @ApiFindAllCars()
  async findAll(@Query() query: FindAllCarQuery) { ... }

  @Get(':id')
  @ApiFindOneCar()
  async findOne(@Param() params: CarIdDto) { ... }

  @Patch(':id')
  @ApiUpdateCar()
  async update(@Param() params: CarIdDto, @Body() dto: UpdateCarDto) { ... }

  @Delete(':id')
  @ApiRemoveCar()
  async remove(@Param() params: CarIdDto) { ... }
}
```

---

## 3. DTO Documentation

### ApiProperty Decorators

```typescript
// domain/dtos/{entity}/create-{entity}.dto.ts

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCarDto {
  // Required field
  @ApiProperty({
    description: 'Car brand name',
    example: 'Toyota',
    minLength: 2,
    maxLength: 50,
  })
  @IsString()
  @IsNotEmpty()
  brand: string;

  // Optional field
  @ApiPropertyOptional({
    description: 'Car color',
    example: 'Red',
  })
  @IsOptional()
  @IsString()
  color?: string;

  // Numeric with constraints
  @ApiProperty({
    description: 'Manufacturing year',
    example: 2024,
    minimum: 1900,
    maximum: 2100,
  })
  @IsInt()
  @Min(1900)
  @Max(2100)
  year: number;

  // Decimal
  @ApiPropertyOptional({
    description: 'Price in currency units',
    example: 25000.99,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  price?: number;

  // Boolean with default
  @ApiPropertyOptional({
    description: 'Whether the car is available for sale',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  // Enum
  @ApiProperty({
    description: 'Car status',
    enum: CarStatus,
    example: CarStatus.AVAILABLE,
  })
  @IsEnum(CarStatus)
  status: CarStatus;

  // Tenant-specific with note
  @ApiPropertyOptional({
    description: 'Vehicle Identification Number (Liverpool only)',
    example: '1HGBH41JXMN109186',
  })
  @IsOptional()
  @IsString()
  @Length(17, 17)
  vin?: string;
}
```

### Response DTO

```typescript
// domain/dtos/{entity}/{entity}.dto.ts

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CarDto {
  @ApiProperty({
    description: 'Unique identifier',
    example: 'clxxxxxxxxxxxxxxxxxx',
  })
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

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2024-01-15T10:30:00.000Z',
  })
  updatedAt: Date;
}
```

### Paginated Response

```typescript
// domain/dtos/{entity}/paginated-{entity}s.dto.ts

import { ApiProperty } from '@nestjs/swagger';
import { CarDto } from './car.dto';

export class PaginatedCarsDto {
  @ApiProperty({
    type: [CarDto],
    description: 'Array of cars',
  })
  data: CarDto[];

  @ApiProperty({
    description: 'Total number of records',
    example: 100,
  })
  total: number;

  @ApiProperty({
    description: 'Current page number',
    example: 1,
  })
  page: number;

  @ApiProperty({
    description: 'Items per page',
    example: 10,
  })
  limit: number;

  @ApiProperty({
    description: 'Total number of pages',
    example: 10,
  })
  totalPages: number;
}
```

---

## 4. Response Examples

### Success Response Schema

```typescript
// shared/types/api-response.dto.ts

import { ApiProperty } from '@nestjs/swagger';

export class ApiSuccessResponse<T> {
  @ApiProperty({ example: 'OK' })
  status: string;

  @ApiProperty()
  data: T;
}
```

### Using in Controller

```typescript
@ApiResponse({
  status: 200,
  description: 'Success response',
  schema: {
    properties: {
      status: { type: 'string', example: 'OK' },
      data: { $ref: '#/components/schemas/CarDto' },
    },
  },
})
```

---

## 5. Authentication Documentation

### Bearer Token

```typescript
// In DocumentBuilder
.addBearerAuth({
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  name: 'JWT',
  description: 'Enter JWT token (includes tenant claim)',
  in: 'header',
})

// In Controller
@ApiBearerAuth()
@Controller('cars')
export class CarController { ... }
```

### API Key (if used)

```typescript
// In DocumentBuilder
.addApiKey({
  type: 'apiKey',
  name: 'X-API-KEY',
  in: 'header',
  description: 'API Key for service authentication',
})
```

---

## 6. Multi-Tenant Documentation

### Document Tenant Differences

```typescript
@ApiOperation({
  summary: 'Create a new car',
  description: `
Creates a new car in the tenant's database.

**Tenant-specific fields:**
- **Liverpool**: \`vin\`, \`mileage\`, \`interiorColor\`, \`hasWarranty\`
- **Suburbia**: \`discount\`, \`category\`, \`isFeatured\`

Sending Liverpool fields to Suburbia (or vice versa) will result in a 400 error.
  `,
})
```

---

## 7. Grouping Endpoints

### By Feature

```typescript
// Use meaningful tags with emojis
@ApiTags('🚗 Cars - Car Management')
@ApiTags('📋 Audit Log - Activity Tracking')
@ApiTags('🏥 Health - System Status')
@ApiTags('🔧 Admin - Administrative Operations')
```

### In DocumentBuilder

```typescript
const config = new DocumentBuilder()
  .addTag('🚗 Cars - Car Management', 'CRUD operations for cars')
  .addTag('📋 Audit Log', 'Query audit logs and activity history')
  .addTag('🏥 Health', 'Health check endpoints')
  .build();
```

---

## 8. Checklist

- [ ] Swagger setup in main.ts
- [ ] Tags for all controllers
- [ ] ApiOperation for each endpoint
- [ ] ApiResponse for success and error cases
- [ ] ApiProperty on all DTO fields
- [ ] Examples for all fields
- [ ] Bearer auth configured
- [ ] Tenant differences documented
- [ ] Pagination parameters documented
- [ ] Decorator files for clean controllers
