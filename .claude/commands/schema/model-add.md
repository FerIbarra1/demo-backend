---
description: Add new Prisma model to both tenant schemas
model: claude-sonnet-4-5
---

# Add Prisma Model - NOVA Microservicio Autos

Add a new Prisma model to both tenant schemas with proper configuration.

## Model Details

$ARGUMENTS

## Model Template

### 1. Liverpool Schema (prisma/liverpool/schema.prisma)

```prisma
// ============================================================================
// {{MODEL_NAME}} MODEL
// ============================================================================
// Description of what this model represents
// ============================================================================

model {{Model}} {
    id          String   @id @default(cuid())

    // Core fields (shared)
    name        String
    description String?
    status      String   @default("ACTIVE")

    // Liverpool-specific fields
    liverpoolField1  String?
    liverpoolField2  Int?

    // Timestamps
    createdAt   DateTime @default(now())
    updatedAt   DateTime @updatedAt

    // Indexes
    @@index([status])
    @@index([createdAt])
    @@map("{{model}}s")  // Table name in snake_case plural
}
```

### 2. Suburbia Schema (prisma/suburbia/schema.prisma)

```prisma
// ============================================================================
// {{MODEL_NAME}} MODEL
// ============================================================================
// Description of what this model represents
// ============================================================================

model {{Model}} {
    id          String   @id @default(cuid())

    // Core fields (shared)
    name        String
    description String?
    status      String   @default("ACTIVE")

    // Suburbia-specific fields
    suburbiaField1   Decimal? @db.Decimal(5, 2)
    suburbiaField2   Boolean  @default(false)

    // Timestamps
    createdAt   DateTime @default(now())
    updatedAt   DateTime @updatedAt

    // Indexes
    @@index([status])
    @@index([createdAt])
    @@map("{{model}}s")
}
```

### 3. Field Type Reference

| Prisma Type            | SQL Server Type | Example                              |
| ---------------------- | --------------- | ------------------------------------ |
| String                 | nvarchar(1000)  | `name String`                        |
| String @db.Text        | nvarchar(max)   | `description String? @db.Text`       |
| String @db.VarChar(50) | varchar(50)     | `code String @db.VarChar(50)`        |
| Int                    | int             | `quantity Int`                       |
| Float                  | float(53)       | `rating Float`                       |
| Decimal                | decimal         | `price Decimal @db.Decimal(10, 2)`   |
| Boolean                | bit             | `isActive Boolean @default(true)`    |
| DateTime               | datetime2       | `createdAt DateTime @default(now())` |
| DateTime @db.Date      | date            | `birthDate DateTime? @db.Date`       |

### 4. Common Patterns

**Enum:**

```prisma
enum {{Model}}Status {
    ACTIVE
    INACTIVE
    PENDING
    DELETED
}

model {{Model}} {
    status {{Model}}Status @default(ACTIVE)
}
```

**Relation (One-to-Many):**

```prisma
model {{Model}} {
    // Foreign key
    carId   String
    car     Car    @relation(fields: [carId], references: [id])

    @@index([carId])
}
```

**Unique Constraint:**

```prisma
model {{Model}} {
    code String @unique

    // Composite unique
    @@unique([tenantId, code])
}
```

**Soft Delete:**

```prisma
model {{Model}} {
    deletedAt DateTime?

    @@index([deletedAt])
}
```

### 5. Commands to Run

```bash
# Push to both databases
npm run prisma:push:all

# Generate both clients
npm run prisma:generate:all

# View in Prisma Studio
npm run prisma:studio:liverpool
npm run prisma:studio:suburbia
```

### 6. Next Steps After Creating Model

1. Generate the module: Use `/module-new` command
2. Or manually create:
   - Domain interfaces
   - DTOs
   - Use Cases
   - DataSources for each tenant
   - Repository
   - Service, Controller, Module

## Create the Prisma model in both schemas.
