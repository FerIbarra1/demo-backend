---
name: testing-patterns
description: This skill should be used when the user asks about "testing", "unit tests", "e2e tests", "jest", "mocking", or mentions test coverage, test patterns, or test implementation.
---

# Testing Patterns - NOVA Microservicio Autos

## Objetivo

Implementar tests efectivos siguiendo las mejores prácticas para el contexto multi-tenant del proyecto.

---

## Arquitectura de Testing

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TESTING PYRAMID                                     │
└─────────────────────────────────────────────────────────────────────────────┘

                          ╱╲
                         ╱  ╲
                        ╱ E2E╲           → Few, slow, expensive
                       ╱______╲
                      ╱        ╲
                     ╱Integration╲       → Some, medium speed
                    ╱____________╲
                   ╱              ╲
                  ╱   Unit Tests   ╲     → Many, fast, cheap
                 ╱__________________╲

TESTING LAYERS:

┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│   Use Case     │  │   DataSource   │  │  Controller    │
│   Unit Tests   │  │  Integration   │  │   E2E Tests    │
│                │  │    Tests       │  │                │
│  - Mock Repo   │  │  - Real Prisma │  │  - HTTP Calls  │
│  - Business    │  │  - Test DB     │  │  - Full Flow   │
│    Logic       │  │  - Queries     │  │  - Both Tenants│
└────────────────┘  └────────────────┘  └────────────────┘
```

---

## 1. Project Structure

```
src/core/car/
├── domain/
│   ├── dtos/
│   │   └── car/
│   │       └── create-car.dto.spec.ts    # DTO validation tests
│   └── use-case/
│       └── car/
│           ├── create-car.usecase.ts
│           └── create-car.usecase.spec.ts  # Use case unit tests
├── infrastructure/
│   └── data-sources/
│       └── car-impl.data-sources/
│           └── car-liverpool.data-sources.spec.ts  # Integration tests
└── presentation/
    └── car/
        └── car.controller.spec.ts  # Controller tests

test/
├── app.e2e-spec.ts           # E2E tests
└── jest-e2e.json             # E2E Jest config
```

---

## 2. Unit Tests - Use Cases

### Basic Use Case Test

```typescript
// domain/use-case/car/create-car.usecase.spec.ts

import { CreateCarUseCase } from './create-car.usecase';
import { CarRepositoryDto } from '../../repositories/car.data-repository';
import { CreateCarDto } from '../../dtos/car/create-car.dto';
import { CustomError } from '@/infrastructure/errors/custom.error';

describe('CreateCarUseCase', () => {
  let useCase: CreateCarUseCase;
  let mockRepository: jest.Mocked<CarRepositoryDto>;

  // Setup before each test
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

  // Test data
  const baseDto: CreateCarDto = {
    brand: 'Toyota',
    model: 'Corolla',
    year: 2024,
  };

  describe('execute', () => {
    describe('Liverpool tenant', () => {
      it('should create car with Liverpool-specific fields', async () => {
        const dto = { ...baseDto, vin: '1HGBH41JXMN109186', mileage: 50000 };
        const expected = { id: 'cuid123', ...dto, createdAt: new Date() };
        mockRepository.create.mockResolvedValue(expected);

        const result = await useCase.execute(dto, 'liverpool');

        expect(result.data).toEqual(expected);
        expect(mockRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ vin: dto.vin, mileage: dto.mileage }),
        );
      });

      it('should reject Suburbia-only fields', async () => {
        const dto = { ...baseDto, discount: 10 };

        await expect(useCase.execute(dto, 'liverpool')).rejects.toThrow(
          CustomError,
        );
        expect(mockRepository.create).not.toHaveBeenCalled();
      });
    });

    describe('Suburbia tenant', () => {
      it('should create car with Suburbia-specific fields', async () => {
        const dto = { ...baseDto, discount: 15, category: 'sedan' };
        const expected = { id: 'cuid456', ...dto, createdAt: new Date() };
        mockRepository.create.mockResolvedValue(expected);

        const result = await useCase.execute(dto, 'suburbia');

        expect(result.data).toEqual(expected);
        expect(mockRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ discount: 15, category: 'sedan' }),
        );
      });

      it('should reject Liverpool-only fields', async () => {
        const dto = { ...baseDto, vin: 'ABC123' };

        await expect(useCase.execute(dto, 'suburbia')).rejects.toThrow(
          CustomError,
        );
      });
    });
  });
});
```

### Update Use Case Test

```typescript
// domain/use-case/car/update-car.usecase.spec.ts

describe('UpdateCarUseCase', () => {
  let useCase: UpdateCarUseCase;
  let mockRepository: jest.Mocked<CarRepositoryDto>;

  beforeEach(() => {
    mockRepository = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    useCase = new UpdateCarUseCase(mockRepository);
  });

  describe('execute', () => {
    it('should update existing car', async () => {
      const existingCar = {
        id: '1',
        brand: 'Toyota',
        model: 'Corolla',
        year: 2024,
      };
      const updateData = { brand: 'Honda' };

      mockRepository.findOne.mockResolvedValue(existingCar);
      mockRepository.update.mockResolvedValue({
        ...existingCar,
        ...updateData,
      });

      const result = await useCase.execute(
        { idDto: { id: '1' }, data: updateData },
        'liverpool',
      );

      expect(result.data.brand).toBe('Honda');
    });

    it('should throw not found when car does not exist', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(
        useCase.execute(
          { idDto: { id: 'nonexistent' }, data: {} },
          'liverpool',
        ),
      ).rejects.toThrow(CustomError);
    });
  });
});
```

### Multi-Tenant Test Pattern

```typescript
// Test both tenants with describe.each
describe.each(['liverpool', 'suburbia'] as const)('Tenant: %s', tenant => {
  it(`should process request for ${tenant}`, async () => {
    const result = await useCase.execute(dto, tenant);
    expect(result.data).toBeDefined();
  });
});
```

---

## 3. DTO Validation Tests

```typescript
// domain/dtos/car/create-car.dto.spec.ts

import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateCarDto } from './create-car.dto';

describe('CreateCarDto', () => {
  const validDto = {
    brand: 'Toyota',
    model: 'Corolla',
    year: 2024,
  };

  describe('validation', () => {
    it('should pass with valid required fields', async () => {
      const dto = plainToInstance(CreateCarDto, validDto);
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should fail without brand', async () => {
      const dto = plainToInstance(CreateCarDto, {
        model: 'Corolla',
        year: 2024,
      });
      const errors = await validate(dto);
      expect(errors.some(e => e.property === 'brand')).toBe(true);
    });

    it('should fail with invalid year (too low)', async () => {
      const dto = plainToInstance(CreateCarDto, { ...validDto, year: 1800 });
      const errors = await validate(dto);
      expect(errors.some(e => e.property === 'year')).toBe(true);
    });

    it('should fail with invalid year (too high)', async () => {
      const dto = plainToInstance(CreateCarDto, { ...validDto, year: 2200 });
      const errors = await validate(dto);
      expect(errors.some(e => e.property === 'year')).toBe(true);
    });

    it('should accept optional fields', async () => {
      const dto = plainToInstance(CreateCarDto, {
        ...validDto,
        color: 'Red',
        price: 25000.99,
        description: 'Nice car',
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should fail with invalid price (negative)', async () => {
      const dto = plainToInstance(CreateCarDto, { ...validDto, price: -100 });
      const errors = await validate(dto);
      expect(errors.some(e => e.property === 'price')).toBe(true);
    });
  });
});
```

---

## 4. Integration Tests - DataSource

```typescript
// infrastructure/data-sources/car-impl.data-sources/car-liverpool.data-sources.spec.ts

import { PrismaLiverpoolService } from '@/infrastructure/prisma/prisma-liverpool.service';
import { CarLiverpoolMsSqlDataSources } from './car-liverpool-mssql.data-sources';
import { CustomError } from '@/infrastructure/errors/custom.error';

describe('CarLiverpoolMsSqlDataSources (Integration)', () => {
  let dataSource: CarLiverpoolMsSqlDataSources;
  let prisma: PrismaLiverpoolService;

  beforeAll(async () => {
    prisma = new PrismaLiverpoolService();
    await prisma.$connect();
    dataSource = new CarLiverpoolMsSqlDataSources(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data
    await prisma.car.deleteMany({
      where: { brand: { startsWith: 'TEST_' } },
    });
  });

  describe('create', () => {
    it('should create a car', async () => {
      const dto = {
        brand: 'TEST_Toyota',
        model: 'Corolla',
        year: 2024,
        vin: 'TEST_VIN_' + Date.now(),
      };

      const result = await dataSource.create(dto);

      expect(result.id).toBeDefined();
      expect(result.brand).toBe(dto.brand);
      expect(result.vin).toBe(dto.vin);
    });

    it('should throw on duplicate VIN', async () => {
      const dto = {
        brand: 'TEST_Toyota',
        model: 'Corolla',
        year: 2024,
        vin: 'TEST_DUP_VIN',
      };

      await dataSource.create(dto);

      await expect(dataSource.create(dto)).rejects.toThrow(CustomError);
    });
  });

  describe('findAll', () => {
    it('should return paginated results', async () => {
      // Create test data
      await Promise.all([
        dataSource.create({ brand: 'TEST_A', model: 'A', year: 2024 }),
        dataSource.create({ brand: 'TEST_B', model: 'B', year: 2024 }),
        dataSource.create({ brand: 'TEST_C', model: 'C', year: 2024 }),
      ]);

      const result = await dataSource.findAll({ page: 1, limit: 2 });

      expect(result.data.length).toBe(2);
      expect(result.total).toBeGreaterThanOrEqual(3);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });
  });
});
```

---

## 5. E2E Tests

```typescript
// test/car.e2e-spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { MainModule } from '../src/main/main.module';

describe('CarController (e2e)', () => {
  let app: INestApplication;
  let liverpoolToken: string;
  let suburbiaToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [MainModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    // Get tokens for both tenants
    liverpoolToken = 'jwt-token-with-liverpool-tenant';
    suburbiaToken = 'jwt-token-with-suburbia-tenant';
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /cars', () => {
    describe('Liverpool tenant', () => {
      it('should create car with Liverpool fields', () => {
        return request(app.getHttpServer())
          .post('/cars')
          .set('Authorization', `Bearer ${liverpoolToken}`)
          .send({
            brand: 'Toyota',
            model: 'Corolla',
            year: 2024,
            vin: 'TEST_E2E_VIN_' + Date.now(),
            mileage: 50000,
          })
          .expect(201)
          .expect(res => {
            expect(res.body.status).toBe('OK');
            expect(res.body.data.vin).toBeDefined();
          });
      });

      it('should reject Suburbia fields', () => {
        return request(app.getHttpServer())
          .post('/cars')
          .set('Authorization', `Bearer ${liverpoolToken}`)
          .send({
            brand: 'Toyota',
            model: 'Corolla',
            year: 2024,
            discount: 10, // Suburbia-only
          })
          .expect(400);
      });
    });

    describe('Suburbia tenant', () => {
      it('should create car with Suburbia fields', () => {
        return request(app.getHttpServer())
          .post('/cars')
          .set('Authorization', `Bearer ${suburbiaToken}`)
          .send({
            brand: 'Toyota',
            model: 'Corolla',
            year: 2024,
            discount: 15,
            category: 'sedan',
          })
          .expect(201)
          .expect(res => {
            expect(res.body.status).toBe('OK');
            expect(res.body.data.discount).toBe(15);
          });
      });

      it('should reject Liverpool fields', () => {
        return request(app.getHttpServer())
          .post('/cars')
          .set('Authorization', `Bearer ${suburbiaToken}`)
          .send({
            brand: 'Toyota',
            model: 'Corolla',
            year: 2024,
            vin: 'ABC123', // Liverpool-only
          })
          .expect(400);
      });
    });
  });

  describe('GET /cars', () => {
    it('should return paginated cars', () => {
      return request(app.getHttpServer())
        .get('/cars')
        .set('Authorization', `Bearer ${liverpoolToken}`)
        .query({ page: 1, limit: 10 })
        .expect(200)
        .expect(res => {
          expect(res.body.status).toBe('OK');
          expect(Array.isArray(res.body.data.data)).toBe(true);
          expect(res.body.data.total).toBeDefined();
        });
    });
  });
});
```

---

## 6. Mocking Utilities

### Mock Repository Factory

```typescript
// test/utils/mock-repository.factory.ts

export function createMockRepository<T>(): jest.Mocked<T> {
  return {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  } as unknown as jest.Mocked<T>;
}

// Usage
const mockRepo = createMockRepository<CarRepositoryDto>();
```

### Mock Auth Context

```typescript
// test/utils/mock-auth-context.ts

export const createMockAuthContext = (tenant: 'liverpool' | 'suburbia') => ({
  tenant,
  userId: 'test-user-id',
});
```

---

## 7. Jest Configuration

```javascript
// jest.config.js

module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
};
```

---

## 8. Checklist

- [ ] Unit tests for all Use Cases
- [ ] Both tenants tested (describe.each)
- [ ] Tenant-specific field validation tested
- [ ] DTO validation tests
- [ ] Repository mocking
- [ ] Integration tests for DataSources
- [ ] E2E tests for critical flows
- [ ] Test cleanup in beforeEach
- [ ] Coverage reports configured
- [ ] CI/CD test integration
