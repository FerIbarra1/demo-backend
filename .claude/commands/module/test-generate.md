---
description: Generate tests for module/endpoint in NOVA Microservicio Autos
model: claude-sonnet-4-5
---

# Generate Tests - NOVA Microservicio Autos

Generate comprehensive tests for the specified module or endpoint.

## Target

$ARGUMENTS

## Test Strategy

### 1. Test Types to Generate

| Type        | What to Test         | Location                    |
| ----------- | -------------------- | --------------------------- |
| Unit        | Use Cases, DTOs      | `*.spec.ts` next to source  |
| Integration | Controller + Service | `*.spec.ts` in presentation |
| E2E         | Full API flow        | `test/*.e2e-spec.ts`        |

### 2. Use Case Unit Test Template

```typescript
import { {{UseCase}} } from './{{usecase}}.usecase';
import { {{Repository}}Dto } from '../../repositories/{{entity}}.data-repository';
import { CustomError } from '@/infrastructure/errors/custom.error';

describe('{{UseCase}}', () => {
  let useCase: {{UseCase}};
  let mockRepository: jest.Mocked<{{Repository}}Dto>;

  beforeEach(() => {
    mockRepository = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    useCase = new {{UseCase}}(mockRepository);
  });

  describe('execute', () => {
    it('should succeed for Liverpool tenant', async () => {
      // Arrange
      const dto = { /* valid data */ };
      mockRepository.method.mockResolvedValue(expectedResult);

      // Act
      const result = await useCase.execute(dto, 'liverpool');

      // Assert
      expect(result.data).toBeDefined();
    });

    it('should succeed for Suburbia tenant', async () => {
      const dto = { /* valid data */ };
      mockRepository.method.mockResolvedValue(expectedResult);

      const result = await useCase.execute(dto, 'suburbia');

      expect(result.data).toBeDefined();
    });

    it('should throw on error', async () => {
      mockRepository.method.mockRejectedValue(new Error('DB error'));

      await expect(useCase.execute(dto, 'liverpool')).rejects.toThrow();
    });
  });
});
```

### 3. DTO Validation Test Template

```typescript
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Create{{Entity}}Dto } from './create-{{entity}}.dto';

describe('Create{{Entity}}Dto', () => {
  it('should pass with valid data', async () => {
    const dto = plainToInstance(Create{{Entity}}Dto, {
      /* valid fields */
    });
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should fail without required fields', async () => {
    const dto = plainToInstance(Create{{Entity}}Dto, {});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should fail with invalid types', async () => {
    const dto = plainToInstance(Create{{Entity}}Dto, {
      year: 'not-a-number', // invalid
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
```

### 4. Multi-Tenant Test Scenarios

Always test BOTH tenants:

```typescript
describe('Multi-tenant behavior', () => {
  describe.each(['liverpool', 'suburbia'] as const)('Tenant: %s', tenant => {
    it(`should work for ${tenant}`, async () => {
      const result = await useCase.execute(dto, tenant);
      expect(result.data).toBeDefined();
    });
  });

  describe('Tenant-specific fields', () => {
    it('should accept Liverpool-only fields for Liverpool', async () => {
      const dto = { ...baseDto, vin: 'ABC123', mileage: 50000 };
      const result = await useCase.execute(dto, 'liverpool');
      expect(result.data).toBeDefined();
    });

    it('should reject Liverpool fields for Suburbia', async () => {
      const dto = { ...baseDto, vin: 'ABC123' };
      await expect(useCase.execute(dto, 'suburbia')).rejects.toThrow();
    });
  });
});
```

### 5. Service Test Template

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { {{Entity}}Service } from './{{entity}}.service';
import { AuditLogService } from '@/infrastructure/audit-log';

describe('{{Entity}}Service', () => {
  let service: {{Entity}}Service;
  let mockRepository: jest.Mocked<{{Repository}}Dto>;
  let mockAuditLog: jest.Mocked<AuditLogService>;

  beforeEach(async () => {
    mockRepository = { /* mock methods */ };
    mockAuditLog = { create: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {{Entity}}Service,
        { provide: '{{Entity}}Repository', useValue: mockRepository },
        { provide: AuditLogService, useValue: mockAuditLog },
      ],
    }).compile();

    service = module.get({{Entity}}Service);
  });

  it('should call UseCase and audit log on create', async () => {
    mockRepository.create.mockResolvedValue(createdEntity);

    await service.create(dto, 'liverpool');

    expect(mockAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CREATE' }),
      'liverpool'
    );
  });
});
```

### 6. Run Tests

```bash
npm run test                    # All tests
npm run test:watch             # Watch mode
npm run test:cov               # With coverage
npm run test -- {{entity}}     # Specific file
```

## Generate comprehensive tests for the target.
