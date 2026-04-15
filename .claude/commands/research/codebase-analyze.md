---
description: Analyze codebase patterns and find implementations
model: claude-sonnet-4-5
---

# Research Codebase - NOVA Microservicio Autos

Research and analyze the specified topic in the codebase.

## Research Topic

$ARGUMENTS

## Research Approach

### 1. Pattern Discovery

For "How does X work?":

```
1. Find entry point (usually Controller)
2. Trace: Controller → Service → UseCase → Repository → DataSource
3. Check both tenant implementations
4. Document the flow
```

### 2. File Search Strategies

**By pattern/interface:**

```
src/core/*/domain/data-sources/    → Abstract interfaces
src/core/*/domain/use-case/        → Business logic
src/core/*/infrastructure/         → Implementations
```

**By functionality:**

```
Multi-tenant: src/infrastructure/prisma/prisma-multi-tenant.service.ts
Auth/Tenant:  src/infrastructure/auth/context/
Errors:       src/infrastructure/errors/custom.error.ts
Response:     src/shared/rules/api.rule.response.ts
```

### 3. Key Patterns to Document

**Multi-Tenant Factory:**

- How tenant is resolved from JWT
- How DataSource is selected
- Request-scoped injection

**Use Case Pattern:**

- Interface: `UseCaseGeneric<T>`
- Repository injection
- Provider parameter usage

**Error Handling:**

- `CustomError` static methods
- Prisma error codes
- Response format

**Response Wrapping:**

- `ApiRuleResponse.success()`
- Standard response structure

### 4. Reference Files

| Topic                   | File                                                      |
| ----------------------- | --------------------------------------------------------- |
| Complete module example | `src/core/car/`                                           |
| Multi-tenant setup      | `src/core/car/presentation/car/car.module.ts`             |
| Use Case example        | `src/core/car/domain/use-case/car/create-car.usecase.ts`  |
| DataSource example      | `src/core/car/infrastructure/data-sources/`               |
| Auth context            | `src/infrastructure/auth/context/auth-context.service.ts` |
| Error handling          | `src/infrastructure/errors/custom.error.ts`               |

### 5. Output Format

```markdown
## Research: [Topic]

### Overview

Brief explanation.

### Key Files

- [file.ts](path) - Purpose

### Code Flow

Controller → Service → UseCase → Repository → DataSource

### Pattern Example

\`\`\`typescript
// Relevant code
\`\`\`

### Tenant Differences

- Liverpool: ...
- Suburbia: ...

### Important Notes

- Note 1
- Note 2
```

## Provide comprehensive research findings.
