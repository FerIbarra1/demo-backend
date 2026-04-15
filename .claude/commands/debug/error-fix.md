---
description: Debug and fix errors in NOVA Microservicio Autos
model: claude-sonnet-4-5
---

# Debug Error - NOVA Microservicio Autos

Analyze and fix the error following project patterns.

## Error Details

$ARGUMENTS

## Debugging Workflow

### 1. Common Error Categories

| Error Type | Likely Cause                | Where to Look               |
| ---------- | --------------------------- | --------------------------- |
| P2002      | Unique constraint violation | DataSource, catch block     |
| P2025      | Record not found            | Use Case, validation        |
| 401        | Auth token issue            | JWT middleware, AuthContext |
| 400        | DTO validation              | class-validator decorators  |
| 500        | Unhandled exception         | Try-catch, CustomError      |
| Type error | TS compilation              | Import paths, interfaces    |
| DI error   | Provider not found          | Module providers config     |

### 2. Check Layer by Layer

**Controller → Service → UseCase → Repository → DataSource → Prisma**

```typescript
// Add console.log at each layer
console.log('[Controller] Input:', dto);
console.log('[Service] Calling UseCase with:', dto, provider);
console.log('[UseCase] Repository call:', payload);
console.log('[DataSource] Prisma query:', data);
```

### 3. Common Fixes

**CustomError handling:**

```typescript
try {
  return await this.prisma.entity.create({ data });
} catch (error: any) {
  if (error?.code === 'P2002') {
    throw CustomError.badRequest({
      description: 'Registro duplicado.',
    });
  }
  if (error?.code === 'P2025') {
    throw CustomError.notFound({
      description: 'Registro no encontrado.',
    });
  }
  throw error;
}
```

**Missing provider:**

```typescript
// In module
{
  provide: 'EntityRepository',
  scope: Scope.REQUEST,  // Don't forget scope!
  useFactory: (prismaMultiTenant, authContext) => {
    // ...
  },
  inject: [PrismaMultiTenantService, AuthContextService],
}
```

**Import path issues:**

```typescript
// Use path aliases
import { CustomError } from '@/infrastructure/errors/custom.error';
// NOT relative paths from far directories
```

**Tenant resolution:**

```typescript
// Ensure AuthContextService is injected
constructor(
  private readonly authContext: AuthContextService,
) {}

// Access tenant
const tenant = this.authContext.tenant;
```

### 4. Prisma-Specific Debugging

```bash
# Check schema sync
npx prisma db pull --schema=prisma/liverpool/schema.prisma

# View current data
npm run prisma:studio:liverpool

# Check generated client
ls node_modules/.prisma/client-liverpool
```

### 5. TypeScript Compilation

```bash
# Check for type errors
npx tsc --noEmit

# Specific file
npx tsc --noEmit src/core/entity/domain/use-case/entity/create-entity.usecase.ts
```

### 6. Runtime Debugging

```bash
# Start with debug mode
npm run start:debug

# Or add NODE_OPTIONS
NODE_OPTIONS='--inspect' npm run start:dev
```

## Analyze the error and provide the fix with explanation.
