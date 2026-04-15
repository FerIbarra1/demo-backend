---
description: Analyze task complexity and create actionable implementation plan for NOVA Microservicio Autos
model: claude-sonnet-4-5
---

# Task Analysis - NOVA Microservicio Autos

Analyze the following task and create a clear, actionable implementation plan considering the multi-tenant architecture.

## Task

$ARGUMENTS

## Analysis Framework

### 1. Task Breakdown

- Understand requirements
- Identify affected modules and layers
- Check tenant impact (Liverpool/Suburbia/Both)
- List files to create/modify
- Estimate complexity

### 2. Architecture Impact

**Layers affected:**

- [ ] Domain (Use Cases, DTOs, Interfaces)
- [ ] Infrastructure (DataSources, Repositories)
- [ ] Presentation (Controller, Service, Module)
- [ ] Prisma Schemas (Liverpool/Suburbia)

**Multi-tenant considerations:**

- Does it affect both tenants?
- Are there tenant-specific fields?
- Need separate DataSource implementations?

### 3. Complexity Assessment

| Level      | Time | Examples                              |
| ---------- | ---- | ------------------------------------- |
| Small      | 1-2h | Bug fix, add field to existing model  |
| Medium     | 4-8h | New endpoint, new DTO with validation |
| Large      | 1-2d | New module with CRUD operations       |
| Very Large | 3-5d | Multi-module feature, schema changes  |

### 4. Implementation Order

For this project, always follow:

```
1. Prisma schemas (both tenants)
2. Domain interfaces (abstract)
3. DTOs with class-validator
4. Use Cases
5. Infrastructure implementations
6. Presentation layer
7. Module registration
```

### 5. Risk Assessment

- Breaking changes to existing APIs?
- Database migration needed?
- Multi-tenant data isolation concerns?
- Performance implications?

## Output Format

### Task Summary

- **Type**: [Bug Fix / Feature / Refactor / Schema Change]
- **Complexity**: [Small / Medium / Large / Very Large]
- **Tenants Affected**: [Liverpool / Suburbia / Both]
- **Estimated Time**: X hours/days

### Implementation Plan

**Phase 1: Schema & Interfaces** (Time)

- [ ] Update prisma/liverpool/schema.prisma
- [ ] Update prisma/suburbia/schema.prisma
- [ ] Create domain interfaces

**Phase 2: Domain Layer** (Time)

- [ ] Create DTOs
- [ ] Implement Use Cases

**Phase 3: Infrastructure** (Time)

- [ ] Liverpool DataSource
- [ ] Suburbia DataSource
- [ ] Repository implementation

**Phase 4: Presentation** (Time)

- [ ] Service (orchestration)
- [ ] Controller
- [ ] Module with DI

### Files to Create/Modify

```
src/core/{module}/domain/...
src/core/{module}/infrastructure/...
src/core/{module}/presentation/...
prisma/liverpool/schema.prisma
prisma/suburbia/schema.prisma
```

### Commands to Run

```bash
npm run prisma:push:all
npm run prisma:generate:all
npm run start:dev
```

### Testing Strategy

- Unit tests for Use Cases
- Test both tenant scenarios
- Postman collection update

### Next Steps

1. Start with schema changes
2. Generate Prisma clients
3. Implement layer by layer
4. Test incrementally
