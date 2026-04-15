---
name: use-case-pattern
description: This skill should be used when the user asks about "use case pattern", "business logic", "UseCaseGeneric", "domain logic", or mentions implementing use cases, business rules, or service orchestration.
---

# Use Case Pattern - NOVA Microservicio Autos

## Objetivo

Implementar correctamente el patrón **Use Case** para encapsular toda la lógica de negocio, manteniendo los servicios como simples orquestadores.

---

## Arquitectura del Patrón

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          USE CASE PATTERN                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Controller    │     │    Service      │     │    Use Case     │
│   (HTTP)        │ ──▶ │  (Orchestrate)  │ ──▶ │  (Business)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │   Repository    │
                                               │  (Data Access)  │
                                               └─────────────────┘

RESPONSABILIDADES:

Controller → Recibe HTTP, valida DTO, llama Service, formatea Response
Service    → Instancia Use Case, pasa dependencias, retorna resultado
Use Case   → TODA la lógica de negocio, validaciones, transformaciones
Repository → Acceso a datos, queries, manejo errores de BD
```

---

## 1. UseCaseGeneric Interface

```typescript
// src/shared/types/use-case.ts

export type ProviderType = 'liverpool' | 'suburbia';

/**
 * Interface genérica para todos los Use Cases
 * T = Tipo del argumento principal (DTO, objeto de datos, etc.)
 */
export interface UseCaseGeneric<T> {
  execute(args: T, provider: ProviderType): Promise<any>;
}

// Exportar desde index
// src/shared/index.ts
export * from './types/use-case';
```

---

## 2. Use Case Básico

### Create Use Case

```typescript
// domain/use-case/car/create-car.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { CreateCarDto } from '../../dtos/car/create-car.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

export class CreateCarUseCase implements UseCaseGeneric<CreateCarDto> {
  constructor(private readonly carRepository: CarRepositoryDto) {}

  async execute(dto: CreateCarDto, provider: ProviderType) {
    // 1. Validar reglas de negocio
    this.validateBusinessRules(dto, provider);

    // 2. Preparar payload según tenant
    const payload = this.buildPayload(dto, provider);

    // 3. Persistir
    const data = await this.carRepository.create(payload);

    // 4. Retornar resultado
    return { data };
  }

  private validateBusinessRules(dto: CreateCarDto, provider: ProviderType) {
    // Validar campos específicos de tenant
    if (provider === 'liverpool') {
      this.validateLiverpoolFields(dto);
    } else {
      this.validateSuburbiaFields(dto);
    }
  }

  private validateLiverpoolFields(dto: CreateCarDto) {
    // Campos de Suburbia no permitidos
    const invalidFields = ['discount', 'category', 'isFeatured'].filter(
      field => dto[field] !== undefined,
    );

    if (invalidFields.length > 0) {
      throw CustomError.badRequest({
        description: `Los campos [${invalidFields.join(', ')}] no están disponibles para Liverpool.`,
      });
    }
  }

  private validateSuburbiaFields(dto: CreateCarDto) {
    // Campos de Liverpool no permitidos
    const invalidFields = [
      'vin',
      'mileage',
      'interiorColor',
      'hasWarranty',
    ].filter(field => dto[field] !== undefined);

    if (invalidFields.length > 0) {
      throw CustomError.badRequest({
        description: `Los campos [${invalidFields.join(', ')}] no están disponibles para Suburbia.`,
      });
    }
  }

  private buildPayload(dto: CreateCarDto, provider: ProviderType) {
    const {
      // Campos compartidos
      brand,
      model,
      year,
      color,
      price,
      description,
      isAvailable,
      // Campos Liverpool
      vin,
      mileage,
      interiorColor,
      hasWarranty,
      // Campos Suburbia
      discount,
      category,
      isFeatured,
    } = dto;

    // Campos base (compartidos)
    const base = { brand, model, year, color, price, description, isAvailable };

    if (provider === 'liverpool') {
      return { ...base, vin, mileage, interiorColor, hasWarranty };
    }

    return { ...base, discount, category, isFeatured };
  }
}
```

### Find All Use Case

```typescript
// domain/use-case/car/find-all-car.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { FindAllCarQuery } from '../../dtos/car/find-all-car.query';

export class FindAllCarUseCase implements UseCaseGeneric<FindAllCarQuery> {
  constructor(private readonly carRepository: CarRepositoryDto) {}

  async execute(query: FindAllCarQuery, provider: ProviderType) {
    // Aplicar valores por defecto
    const normalizedQuery = this.normalizeQuery(query);

    // Obtener datos
    const result = await this.carRepository.findAll(normalizedQuery);

    return result;
  }

  private normalizeQuery(query: FindAllCarQuery): FindAllCarQuery {
    return {
      page: query.page || 1,
      limit: Math.min(query.limit || 10, 100), // Máximo 100
      ...query,
    };
  }
}
```

### Find One Use Case

```typescript
// domain/use-case/car/find-one-car.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { CarIdDto } from '../../dtos/car/car-id.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

export class FindOneCarUseCase implements UseCaseGeneric<CarIdDto> {
  constructor(private readonly carRepository: CarRepositoryDto) {}

  async execute(dto: CarIdDto, provider: ProviderType) {
    const data = await this.carRepository.findOne(dto);

    if (!data) {
      throw CustomError.notFound({
        description: `El auto con ID "${dto.id}" no fue encontrado.`,
      });
    }

    return { data };
  }
}
```

### Update Use Case

```typescript
// domain/use-case/car/update-car.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { CarIdDto } from '../../dtos/car/car-id.dto';
import { UpdateCarDto } from '../../dtos/car/update-car.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

interface UpdateCarArgs {
  idDto: CarIdDto;
  data: UpdateCarDto;
}

export class UpdateCarUseCase implements UseCaseGeneric<UpdateCarArgs> {
  constructor(private readonly carRepository: CarRepositoryDto) {}

  async execute({ idDto, data }: UpdateCarArgs, provider: ProviderType) {
    // 1. Verificar que existe
    const existing = await this.carRepository.findOne(idDto);
    if (!existing) {
      throw CustomError.notFound({
        description: `El auto con ID "${idDto.id}" no fue encontrado.`,
      });
    }

    // 2. Validar campos según tenant
    this.validateTenantFields(data, provider);

    // 3. Actualizar
    const updated = await this.carRepository.update(idDto, data);

    return { data: updated };
  }

  private validateTenantFields(dto: UpdateCarDto, provider: ProviderType) {
    const liverpoolFields = ['vin', 'mileage', 'interiorColor', 'hasWarranty'];
    const suburbiaFields = ['discount', 'category', 'isFeatured'];

    const invalidFields =
      provider === 'liverpool'
        ? suburbiaFields.filter(f => dto[f] !== undefined)
        : liverpoolFields.filter(f => dto[f] !== undefined);

    if (invalidFields.length > 0) {
      throw CustomError.badRequest({
        description: `Los campos [${invalidFields.join(', ')}] no están disponibles para ${provider}.`,
      });
    }
  }
}
```

### Remove Use Case

```typescript
// domain/use-case/car/remove-car.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { CarIdDto } from '../../dtos/car/car-id.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

export class RemoveCarUseCase implements UseCaseGeneric<CarIdDto> {
  constructor(private readonly carRepository: CarRepositoryDto) {}

  async execute(dto: CarIdDto, provider: ProviderType) {
    // 1. Verificar que existe
    const existing = await this.carRepository.findOne(dto);
    if (!existing) {
      throw CustomError.notFound({
        description: `El auto con ID "${dto.id}" no fue encontrado.`,
      });
    }

    // 2. Validaciones de negocio antes de eliminar
    this.validateCanDelete(existing);

    // 3. Eliminar
    const data = await this.carRepository.remove(dto);

    return { data };
  }

  private validateCanDelete(car: any) {
    // Ejemplo: No eliminar si tiene ventas pendientes
    // if (car.hasPendingSales) {
    //   throw CustomError.badRequest({
    //     description: 'No se puede eliminar un auto con ventas pendientes.',
    //   });
    // }
  }
}
```

---

## 3. Service como Orquestador

```typescript
// presentation/car/car.service.ts

import { Injectable, Inject } from '@nestjs/common';
import { CarRepositoryDto } from '../../domain/repositories/car.data-repository';
import { ProviderType } from '@/shared';

// Import Use Cases
import {
  CreateCarUseCase,
  FindAllCarUseCase,
  FindOneCarUseCase,
  UpdateCarUseCase,
  RemoveCarUseCase,
} from '../../domain/use-case/car';

// Import DTOs
import { CreateCarDto } from '../../domain/dtos/car/create-car.dto';
import { UpdateCarDto } from '../../domain/dtos/car/update-car.dto';
import { CarIdDto } from '../../domain/dtos/car/car-id.dto';
import { FindAllCarQuery } from '../../domain/dtos/car/find-all-car.query';

@Injectable()
export class CarService {
  constructor(
    @Inject('CarRepository')
    private readonly carRepository: CarRepositoryDto,
  ) {}

  // ✅ CORRECTO: Service solo orquesta
  async create(dto: CreateCarDto, provider: ProviderType) {
    return new CreateCarUseCase(this.carRepository).execute(dto, provider);
  }

  async findAll(query: FindAllCarQuery, provider: ProviderType) {
    return new FindAllCarUseCase(this.carRepository).execute(query, provider);
  }

  async findOne(dto: CarIdDto, provider: ProviderType) {
    return new FindOneCarUseCase(this.carRepository).execute(dto, provider);
  }

  async update(idDto: CarIdDto, data: UpdateCarDto, provider: ProviderType) {
    return new UpdateCarUseCase(this.carRepository).execute(
      { idDto, data },
      provider,
    );
  }

  async remove(dto: CarIdDto, provider: ProviderType) {
    return new RemoveCarUseCase(this.carRepository).execute(dto, provider);
  }
}
```

### ❌ Anti-Pattern: Lógica en Service

```typescript
// ❌ INCORRECTO: Lógica de negocio en Service
@Injectable()
export class CarService {
  async create(dto: CreateCarDto, provider: ProviderType) {
    // ❌ Validación de negocio en service
    if (provider === 'liverpool' && dto.discount) {
      throw CustomError.badRequest({ description: 'Invalid field' });
    }

    // ❌ Transformación en service
    const payload =
      provider === 'liverpool'
        ? { ...dto, mileage: dto.mileage || 0 }
        : { ...dto, discount: dto.discount || 0 };

    return this.carRepository.create(payload);
  }
}
```

---

## 4. Use Case Index File

```typescript
// domain/use-case/car/index.ts

export * from './create-car.usecase';
export * from './find-all-car.usecase';
export * from './find-one-car.usecase';
export * from './update-car.usecase';
export * from './remove-car.usecase';
```

---

## 5. Use Cases con Múltiples Repositorios

```typescript
// domain/use-case/sale/create-sale.usecase.ts

import { UseCaseGeneric, ProviderType } from '@/shared';
import { SaleRepositoryDto } from '../../repositories/sale.data-repository';
import { CarRepositoryDto } from '../../../car/domain/repositories/car.data-repository';
import { CreateSaleDto } from '../../dtos/sale/create-sale.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

export class CreateSaleUseCase implements UseCaseGeneric<CreateSaleDto> {
  constructor(
    private readonly saleRepository: SaleRepositoryDto,
    private readonly carRepository: CarRepositoryDto,
  ) {}

  async execute(dto: CreateSaleDto, provider: ProviderType) {
    // 1. Verificar que el auto existe
    const car = await this.carRepository.findOne({ id: dto.carId });
    if (!car) {
      throw CustomError.notFound({
        description: 'El auto no existe.',
      });
    }

    // 2. Verificar disponibilidad
    if (!car.isAvailable) {
      throw CustomError.badRequest({
        description: 'El auto no está disponible para venta.',
      });
    }

    // 3. Crear venta
    const sale = await this.saleRepository.create(dto);

    // 4. Actualizar disponibilidad del auto
    await this.carRepository.update({ id: dto.carId }, { isAvailable: false });

    return { data: sale };
  }
}
```

---

## 6. Testing Use Cases

```typescript
// domain/use-case/car/create-car.usecase.spec.ts

import { CreateCarUseCase } from './create-car.usecase';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { CustomError } from '@/infrastructure/errors/custom.error';

describe('CreateCarUseCase', () => {
  let useCase: CreateCarUseCase;
  let mockRepository: jest.Mocked<CarRepositoryDto>;

  beforeEach(() => {
    mockRepository = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    useCase = new CreateCarUseCase(mockRepository);
  });

  describe('execute', () => {
    const baseDto = { brand: 'Toyota', model: 'Corolla', year: 2024 };

    it('should create car for Liverpool', async () => {
      const dto = { ...baseDto, vin: 'ABC123' };
      mockRepository.create.mockResolvedValue({ id: '1', ...dto });

      const result = await useCase.execute(dto, 'liverpool');

      expect(result.data).toBeDefined();
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ vin: 'ABC123' }),
      );
    });

    it('should reject Suburbia fields for Liverpool', async () => {
      const dto = { ...baseDto, discount: 10 };

      await expect(useCase.execute(dto, 'liverpool')).rejects.toThrow(
        CustomError,
      );
    });

    it('should create car for Suburbia', async () => {
      const dto = { ...baseDto, discount: 10 };
      mockRepository.create.mockResolvedValue({ id: '1', ...dto });

      const result = await useCase.execute(dto, 'suburbia');

      expect(result.data).toBeDefined();
    });

    it('should reject Liverpool fields for Suburbia', async () => {
      const dto = { ...baseDto, vin: 'ABC123' };

      await expect(useCase.execute(dto, 'suburbia')).rejects.toThrow(
        CustomError,
      );
    });
  });
});
```

---

## 7. Checklist

- [ ] Cada operación tiene su Use Case dedicado
- [ ] Use Cases implementan `UseCaseGeneric<T>`
- [ ] Toda lógica de negocio está en Use Cases
- [ ] Services solo instancian y ejecutan Use Cases
- [ ] Use Cases reciben Repository por constructor
- [ ] Provider (tenant) se pasa al execute()
- [ ] Validaciones de tenant en Use Cases
- [ ] Index file exporta todos los Use Cases
- [ ] Tests unitarios para cada Use Case
