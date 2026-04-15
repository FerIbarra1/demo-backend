---
description: Add new endpoint to existing module in NOVA Microservicio Autos
model: claude-sonnet-4-5
---

# Add Endpoint - NOVA Microservicio Autos

Add a new endpoint to an existing module following project patterns.

## Endpoint Details

$ARGUMENTS

## Implementation Checklist

### 1. Analyze Requirements

- HTTP Method: GET / POST / PATCH / DELETE
- Route path and parameters
- Request body (if any)
- Response structure
- Tenant-specific behavior

### 2. Files to Create/Modify

**Domain Layer:**

- [ ] DTO for request body/query (if needed)
- [ ] Use Case for business logic
- [ ] Update Repository interface (if new data access)
- [ ] Update DataSource interface (if new data access)

**Infrastructure Layer:**

- [ ] Liverpool DataSource implementation
- [ ] Suburbia DataSource implementation
- [ ] Repository implementation

**Presentation Layer:**

- [ ] Add method to Service
- [ ] Add endpoint to Controller
- [ ] Add Swagger decorator

### 3. Code Patterns

**Controller Endpoint:**

```typescript
@Get('custom-endpoint')
@ApiCustomEndpoint()
async customEndpoint(@Query() query: CustomQueryDto) {
  const result = await this.service.customMethod(query, this.authContext.tenant);
  return ApiRuleResponse.success(result);
}
```

**Service Method:**

```typescript
async customMethod(query: CustomQueryDto, provider: ProviderType) {
  return new CustomUseCase(this.repository).execute(query, provider);
}
```

**Use Case:**

```typescript
export class CustomUseCase implements UseCaseGeneric<CustomQueryDto> {
  constructor(private readonly repository: EntityRepositoryDto) {}

  async execute(query: CustomQueryDto, provider: ProviderType) {
    // Business logic
    const data = await this.repository.customMethod(query);
    return { data };
  }
}
```

### 4. Swagger Decorator

```typescript
export const ApiCustomEndpoint = () =>
  applyDecorators(
    ApiOperation({ summary: 'Description of endpoint' }),
    ApiResponse({ status: 200, description: 'Success response' }),
    ApiResponse({ status: 400, description: 'Bad request' }),
  );
```

### 5. Export Updates

Don't forget to export from barrel files:

- `domain/use-case/{entity}/index.ts`
- `domain/dtos/{entity}/index.ts`
- `presentation/{entity}/decorators/index.ts`

## Generate all necessary files for the new endpoint.
