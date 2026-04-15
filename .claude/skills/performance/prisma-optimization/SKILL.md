---
name: prisma-optimization
description: This skill should be used when the user asks about "Prisma optimization", "database performance", "slow queries", "N+1 problem", "query optimization", or mentions database indexes, Prisma queries, SQL performance, or data access patterns.
---

# Prisma & Database Optimization - NOVA Microservicio Autos

## Objetivo

Optimizar el rendimiento de las operaciones de base de datos usando Prisma con SQL Server en el contexto multi-tenant.

---

## Arquitectura de Datos

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DATABASE ARCHITECTURE                                │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────┐     ┌────────────────────────────┐
│      Liverpool DB          │     │      Suburbia DB           │
│   qa_liverpool_autos       │     │   qa_suburbia_autos        │
├────────────────────────────┤     ├────────────────────────────┤
│  .prisma/client-liverpool  │     │  .prisma/client-suburbia   │
│                            │     │                            │
│  - Different schema        │     │  - Different schema        │
│  - Liverpool-only fields   │     │  - Suburbia-only fields    │
└────────────────────────────┘     └────────────────────────────┘
              │                                 │
              └─────────────┬───────────────────┘
                            │
                            ▼
              ┌────────────────────────────┐
              │   PrismaMultiTenantService │
              │                            │
              │   .liverpool → Liverpool   │
              │   .suburbia  → Suburbia    │
              └────────────────────────────┘
```

---

## 1. Query Optimization

### Pagination Pattern (CRITICAL)

```typescript
// ✅ CORRECT: Efficient pagination
async findAll(query: FindAllEntityQuery): Promise<PaginatedEntitiesDto> {
  const { page, limit, ...filters } = query;
  const skip = (page - 1) * limit;

  // Parallel execution for better performance
  const [data, total] = await Promise.all([
    this.prisma.entity.findMany({
      where: this.buildWhere(filters),
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    this.prisma.entity.count({ where: this.buildWhere(filters) }),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ❌ WRONG: Sequential execution
async findAll(query) {
  const data = await this.prisma.entity.findMany({ ... });
  const total = await this.prisma.entity.count({ ... }); // Waits for first query
  return { data, total };
}
```

### Select Only Needed Fields

```typescript
// ✅ CORRECT: Select specific fields
async getBasicInformation(dto: EntityIdDto): Promise<EntityBasicInfoDto | null> {
  return this.prisma.entity.findUnique({
    where: { id: dto.id },
    select: {
      id: true,
      brand: true,
      model: true,
      year: true,
      // Only fields we need
    },
  });
}

// ❌ WRONG: Returns all fields when only a few are needed
async getBasicInformation(dto: EntityIdDto) {
  return this.prisma.entity.findUnique({
    where: { id: dto.id },
    // Returns ALL fields including large text, relations, etc.
  });
}
```

### Efficient Filtering

```typescript
// ✅ CORRECT: Dynamic where clause
private buildWhere(filters: FindAllEntityQuery): any {
  const where: any = {};

  // String contains (case-insensitive search)
  if (filters.brand) {
    where.brand = { contains: filters.brand };
  }

  // Exact match
  if (filters.year) {
    where.year = filters.year;
  }

  // Boolean filter
  if (filters.isAvailable !== undefined) {
    where.isAvailable = filters.isAvailable;
  }

  // Range filters
  if (filters.minPrice || filters.maxPrice) {
    where.price = {};
    if (filters.minPrice) where.price.gte = filters.minPrice;
    if (filters.maxPrice) where.price.lte = filters.maxPrice;
  }

  // Date range
  if (filters.createdAfter || filters.createdBefore) {
    where.createdAt = {};
    if (filters.createdAfter) where.createdAt.gte = new Date(filters.createdAfter);
    if (filters.createdBefore) where.createdAt.lte = new Date(filters.createdBefore);
  }

  return where;
}
```

---

## 2. Indexing Strategy

### Schema Indexes

```prisma
model Car {
    id          String   @id @default(cuid())
    brand       String
    model       String
    year        Int
    price       Decimal? @db.Decimal(10, 2)
    isAvailable Boolean  @default(true)
    vin         String?  @unique  // Unique = automatic index
    createdAt   DateTime @default(now())
    updatedAt   DateTime @updatedAt

    // Single field indexes
    @@index([brand])           // Frequent filter
    @@index([year])            // Frequent filter
    @@index([isAvailable])     // Frequent filter
    @@index([createdAt])       // Sorting/range queries

    // Composite indexes for common query patterns
    @@index([brand, model])              // Filter by brand + model
    @@index([isAvailable, createdAt])    // Active items sorted by date
    @@index([year, price])               // Year + price range

    @@map("cars")
}
```

### When to Add Indexes

| Query Pattern                                 | Index Needed                        |
| --------------------------------------------- | ----------------------------------- |
| `WHERE brand = 'Toyota'`                      | `@@index([brand])`                  |
| `WHERE brand = 'Toyota' AND year = 2024`      | `@@index([brand, year])`            |
| `ORDER BY createdAt DESC`                     | `@@index([createdAt])`              |
| `WHERE isAvailable = true ORDER BY createdAt` | `@@index([isAvailable, createdAt])` |
| `WHERE vin = 'ABC123'`                        | `@unique` (automatic)               |

---

## 3. N+1 Query Prevention

### Problem: N+1 Queries

```typescript
// ❌ WRONG: N+1 problem
async findAllWithOwner() {
  const cars = await this.prisma.car.findMany();

  // N additional queries!
  return Promise.all(
    cars.map(async (car) => ({
      ...car,
      owner: await this.prisma.user.findUnique({
        where: { id: car.ownerId },
      }),
    }))
  );
}
```

### Solution: Include Relations

```typescript
// ✅ CORRECT: Single query with join
async findAllWithOwner() {
  return this.prisma.car.findMany({
    include: {
      owner: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
}
```

### Solution: Batch Loading

```typescript
// ✅ CORRECT: Two queries instead of N+1
async findAllWithOwner() {
  const cars = await this.prisma.car.findMany();

  // Get unique owner IDs
  const ownerIds = [...new Set(cars.map(c => c.ownerId))];

  // Single query for all owners
  const owners = await this.prisma.user.findMany({
    where: { id: { in: ownerIds } },
  });

  // Map owners to cars
  const ownerMap = new Map(owners.map(o => [o.id, o]));
  return cars.map(car => ({
    ...car,
    owner: ownerMap.get(car.ownerId),
  }));
}
```

---

## 4. Transaction Patterns

### Multiple Operations

```typescript
// ✅ CORRECT: Transaction for multiple operations
async transferOwnership(fromId: string, toId: string, carId: string) {
  return this.prisma.$transaction(async (tx) => {
    // Update car owner
    const car = await tx.car.update({
      where: { id: carId },
      data: { ownerId: toId },
    });

    // Create transfer record
    await tx.transferLog.create({
      data: {
        carId,
        fromUserId: fromId,
        toUserId: toId,
      },
    });

    return car;
  });
}
```

### Batch Operations

```typescript
// ✅ CORRECT: Batch update with transaction
async deactivateOldCars(beforeDate: Date) {
  return this.prisma.$transaction([
    this.prisma.car.updateMany({
      where: {
        createdAt: { lt: beforeDate },
        isAvailable: true,
      },
      data: { isAvailable: false },
    }),
    this.prisma.auditLog.create({
      data: {
        action: 'BATCH_DEACTIVATE',
        entity: 'car',
        // ...
      },
    }),
  ]);
}
```

---

## 5. Query Logging & Debugging

### Enable Query Logging

```typescript
// src/infrastructure/prisma/prisma-liverpool.service.ts

import { PrismaClient } from '.prisma/client-liverpool';

@Injectable()
export class PrismaLiverpoolService extends PrismaClient {
  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : ['error'],
    });

    // Log slow queries
    if (process.env.NODE_ENV === 'development') {
      this.$on('query', e => {
        if (e.duration > 100) {
          // > 100ms
          console.warn(`🐢 Slow query (${e.duration}ms):`);
          console.warn(e.query);
          console.warn('Params:', e.params);
        }
      });
    }
  }
}
```

### Analyze Query Plan

```sql
-- In SQL Server Management Studio
SET STATISTICS IO ON;
SET STATISTICS TIME ON;

-- Run your query
SELECT * FROM cars WHERE brand = 'Toyota' AND year = 2024;

-- Check execution plan for missing indexes
```

---

## 6. Bulk Operations

### Efficient Create Many

```typescript
// ✅ CORRECT: Bulk insert
async createMany(dtos: CreateEntityDto[]) {
  return this.prisma.entity.createMany({
    data: dtos,
    skipDuplicates: true, // Skip records that violate unique constraints
  });
}
```

### Efficient Update Many

```typescript
// ✅ CORRECT: Bulk update
async updateManyStatus(ids: string[], status: string) {
  return this.prisma.entity.updateMany({
    where: { id: { in: ids } },
    data: { status },
  });
}
```

### Efficient Delete

```typescript
// ✅ CORRECT: Soft delete many
async softDeleteMany(ids: string[]) {
  return this.prisma.entity.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: new Date() },
  });
}
```

---

## 7. Connection Pooling

### Configuration

```env
# .env
DATABASE_URL_LIVERPOOL="sqlserver://localhost:1433;database=qa_liverpool_autos;user=sa;password=xxx;trustServerCertificate=true;connection_limit=10"
DATABASE_URL_SUBURBIA="sqlserver://localhost:1433;database=qa_suburbia_autos;user=sa;password=xxx;trustServerCertificate=true;connection_limit=10"
```

### Multi-Tenant Considerations

```typescript
// Each tenant has its own connection pool
// PrismaMultiTenantService manages both

@Injectable()
export class PrismaMultiTenantService {
  constructor(
    private readonly liverpool: PrismaLiverpoolService, // Pool 1
    private readonly suburbia: PrismaSuburbiaService, // Pool 2
  ) {}
}
```

---

## 8. Performance Checklist

### Query Level

- [ ] Use `select` to limit returned fields
- [ ] Use `include` instead of separate queries
- [ ] Implement pagination with `skip/take`
- [ ] Use `Promise.all` for parallel queries
- [ ] Avoid N+1 queries

### Schema Level

- [ ] Add indexes for filtered fields
- [ ] Add composite indexes for common patterns
- [ ] Use `@unique` for unique constraints (auto-indexed)
- [ ] Use appropriate field types

### Application Level

- [ ] Enable query logging in development
- [ ] Monitor slow queries
- [ ] Use transactions for multi-operation tasks
- [ ] Use bulk operations for multiple records

### Infrastructure Level

- [ ] Configure connection pooling
- [ ] Monitor database connections
- [ ] Separate read/write if needed
