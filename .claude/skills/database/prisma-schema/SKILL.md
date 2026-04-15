---
name: prisma-schema-management
description: This skill should be used when the user asks about "Prisma schema", "database schema", "add model", "add field", "schema changes", or mentions Prisma migrations, model definitions, or database structure.
---

# Prisma Schema Management - NOVA Microservicio Autos

## Objetivo

Gestionar correctamente los schemas de Prisma para ambos tenants (Liverpool y Suburbia) manteniendo consistencia y diferencias apropiadas.

---

## Arquitectura de Schemas

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PRISMA SCHEMA STRUCTURE                              │
└─────────────────────────────────────────────────────────────────────────────┘

prisma/
├── liverpool/
│   ├── prisma.config.ts    # Liverpool Prisma config
│   └── schema.prisma       # Liverpool schema
│
└── suburbia/
    ├── prisma.config.ts    # Suburbia Prisma config
    └── schema.prisma       # Suburbia schema

GENERATED CLIENTS:
node_modules/
└── .prisma/
    ├── client-liverpool/   # Liverpool Prisma client
    └── client-suburbia/    # Suburbia Prisma client
```

---

## 1. Schema Configuration

### Liverpool Config

```typescript
// prisma/liverpool/prisma.config.ts

import { defineConfig } from 'prisma';

export default defineConfig({
  earlyAccess: true,
  schema: './schema.prisma',
});
```

### Suburbia Config

```typescript
// prisma/suburbia/prisma.config.ts

import { defineConfig } from 'prisma';

export default defineConfig({
  earlyAccess: true,
  schema: './schema.prisma',
});
```

---

## 2. Schema Template

### Liverpool Schema

```prisma
// prisma/liverpool/schema.prisma

generator client {
    provider = "prisma-client-js"
    output   = "../../node_modules/.prisma/client-liverpool"
}

datasource db {
    provider = "sqlserver"
    url      = env("DATABASE_URL_LIVERPOOL")
}

// ============================================================
// MODELS
// ============================================================

model Car {
    id           String   @id @default(cuid())
    brand        String
    model        String
    year         Int
    color        String?
    price        Decimal? @db.Decimal(10, 2)
    description  String?  @db.Text
    isAvailable  Boolean  @default(true)

    // Liverpool-specific fields
    vin          String?  @unique
    mileage      Int?
    interiorColor String?
    hasWarranty  Boolean  @default(false)

    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt

    @@index([brand])
    @@index([year])
    @@index([isAvailable])
    @@index([createdAt])
    @@map("cars")
}

model AuditLog {
    id           String   @id @default(cuid())
    provider     String
    action       String
    status       String
    entity       String
    entityId     String?
    method       String
    endpoint     String
    requestBody  String?  @db.Text
    response     String?  @db.Text
    errorMessage String?  @db.Text
    userAgent    String?
    ipAddress    String?
    duration     Int?
    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt

    @@index([provider])
    @@index([status])
    @@index([action])
    @@index([entity])
    @@index([createdAt])
    @@map("audit_logs")
}
```

### Suburbia Schema

```prisma
// prisma/suburbia/schema.prisma

generator client {
    provider = "prisma-client-js"
    output   = "../../node_modules/.prisma/client-suburbia"
}

datasource db {
    provider = "sqlserver"
    url      = env("DATABASE_URL_SUBURBIA")
}

// ============================================================
// MODELS
// ============================================================

model Car {
    id           String   @id @default(cuid())
    brand        String
    model        String
    year         Int
    color        String?
    price        Decimal? @db.Decimal(10, 2)
    description  String?  @db.Text
    isAvailable  Boolean  @default(true)

    // Suburbia-specific fields
    discount     Decimal? @db.Decimal(5, 2)
    category     String?
    isFeatured   Boolean  @default(false)

    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt

    @@index([brand])
    @@index([year])
    @@index([isAvailable])
    @@index([createdAt])
    @@index([category])
    @@map("cars")
}

model AuditLog {
    id           String   @id @default(cuid())
    provider     String
    action       String
    status       String
    entity       String
    entityId     String?
    method       String
    endpoint     String
    requestBody  String?  @db.Text
    response     String?  @db.Text
    errorMessage String?  @db.Text
    userAgent    String?
    ipAddress    String?
    duration     Int?
    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt

    @@index([provider])
    @@index([status])
    @@index([action])
    @@index([entity])
    @@index([createdAt])
    @@map("audit_logs")
}
```

---

## 3. Field Type Reference

### Common Field Patterns

```prisma
// IDs
id           String   @id @default(cuid())    // CUID
id           String   @id @default(uuid())    // UUID
id           Int      @id @default(autoincrement())  // Auto-increment

// Strings
name         String                  // Required VARCHAR(MAX)
name         String   @db.VarChar(100)  // Required VARCHAR(100)
description  String?                 // Optional VARCHAR(MAX)
content      String?  @db.Text       // Optional TEXT (large)
code         String   @unique        // Unique constraint

// Numbers
age          Int                     // Required integer
quantity     Int      @default(0)    // Default value
price        Decimal  @db.Decimal(10, 2)  // Decimal with precision
rating       Float                   // Floating point

// Booleans
isActive     Boolean  @default(true)
isDeleted    Boolean  @default(false)

// Dates
createdAt    DateTime @default(now())
updatedAt    DateTime @updatedAt
deletedAt    DateTime?               // Soft delete

// Enums
status       CarStatus @default(AVAILABLE)

// Relations
ownerId      String
owner        User     @relation(fields: [ownerId], references: [id])
```

### SQL Server Specific Types

```prisma
// Money
amount       Decimal  @db.Money              // Money type
price        Decimal  @db.Decimal(18, 4)     // High precision

// Strings
shortText    String   @db.VarChar(255)
longText     String   @db.Text
unicode      String   @db.NVarChar(255)

// Binary
image        Bytes?   @db.Image
data         Bytes?   @db.VarBinary(Max)

// Date/Time
date         DateTime @db.Date
time         DateTime @db.Time
datetime     DateTime @db.DateTime2
```

---

## 4. Adding New Models

### Step 1: Add to Both Schemas

```prisma
// prisma/liverpool/schema.prisma
// prisma/suburbia/schema.prisma

model Product {
    id          String   @id @default(cuid())

    // Shared fields
    name        String
    sku         String   @unique
    price       Decimal  @db.Decimal(10, 2)
    stock       Int      @default(0)
    isActive    Boolean  @default(true)

    // Tenant-specific fields
    // Liverpool: Add here
    // Suburbia: Add here

    createdAt   DateTime @default(now())
    updatedAt   DateTime @updatedAt

    @@index([sku])
    @@index([isActive])
    @@map("products")
}
```

### Step 2: Add Tenant-Specific Fields

```prisma
// Liverpool version
model Product {
    // ... shared fields ...

    // Liverpool-specific
    warehouse     String?
    minStock      Int     @default(10)
    supplierCode  String?
}

// Suburbia version
model Product {
    // ... shared fields ...

    // Suburbia-specific
    displayOrder  Int     @default(0)
    promoPrice    Decimal? @db.Decimal(10, 2)
    showInHome    Boolean  @default(false)
}
```

### Step 3: Sync and Generate

```bash
# Push schema changes to databases
npm run prisma:push:all

# Generate Prisma clients
npm run prisma:generate:all
```

---

## 5. Adding New Fields

### To Both Tenants

```prisma
// Add to BOTH schemas
model Car {
    // ... existing fields ...

    // New shared field
    engine       String?
}
```

### To One Tenant Only

```prisma
// Liverpool only
model Car {
    // ... existing fields ...
    warrantyExpiry DateTime?  // Liverpool-only
}

// Update DataSource to handle field
// Update DTO with @IsOptional()
// Update Use Case validation
```

---

## 6. Relations

### One-to-Many

```prisma
model User {
    id        String   @id @default(cuid())
    name      String
    cars      Car[]    // One user has many cars
}

model Car {
    id        String   @id @default(cuid())
    ownerId   String
    owner     User     @relation(fields: [ownerId], references: [id])
}
```

### Many-to-Many

```prisma
model Car {
    id         String      @id @default(cuid())
    features   CarFeature[]
}

model Feature {
    id         String      @id @default(cuid())
    name       String
    cars       CarFeature[]
}

model CarFeature {
    carId      String
    featureId  String
    car        Car     @relation(fields: [carId], references: [id])
    feature    Feature @relation(fields: [featureId], references: [id])

    @@id([carId, featureId])
}
```

---

## 7. Enums

```prisma
enum CarStatus {
    AVAILABLE
    SOLD
    RESERVED
    MAINTENANCE
}

model Car {
    // ...
    status    CarStatus @default(AVAILABLE)
}
```

---

## 8. Indexes

### Single Field Index

```prisma
@@index([brand])            // Filter index
@@index([createdAt])        // Sort index
```

### Composite Index

```prisma
@@index([brand, year])           // Multiple filters
@@index([isAvailable, createdAt]) // Filter + sort
```

### Unique Constraint

```prisma
vin    String   @unique          // Single field unique
@@unique([brand, model, year])   // Composite unique
```

---

## 9. NPM Scripts

```json
{
  "scripts": {
    "prisma:generate:liverpool": "prisma generate --schema=prisma/liverpool/schema.prisma",
    "prisma:generate:suburbia": "prisma generate --schema=prisma/suburbia/schema.prisma",
    "prisma:generate:all": "npm run prisma:generate:liverpool && npm run prisma:generate:suburbia",

    "prisma:push:liverpool": "prisma db push --schema=prisma/liverpool/schema.prisma",
    "prisma:push:suburbia": "prisma db push --schema=prisma/suburbia/schema.prisma",
    "prisma:push:all": "npm run prisma:push:liverpool && npm run prisma:push:suburbia",

    "prisma:studio:liverpool": "prisma studio --schema=prisma/liverpool/schema.prisma",
    "prisma:studio:suburbia": "prisma studio --schema=prisma/suburbia/schema.prisma"
  }
}
```

---

## 10. Workflow Checklist

### Adding New Model

- [ ] Add model to Liverpool schema
- [ ] Add model to Suburbia schema
- [ ] Include tenant-specific fields appropriately
- [ ] Add indexes for common queries
- [ ] Run `npm run prisma:push:all`
- [ ] Run `npm run prisma:generate:all`
- [ ] Create DTOs
- [ ] Create Use Cases
- [ ] Create DataSources (both tenants)
- [ ] Create Repository
- [ ] Create Service
- [ ] Create Controller
- [ ] Create Module with factory

### Adding New Field

- [ ] Add field to schema(s)
- [ ] Run `npm run prisma:push:all`
- [ ] Run `npm run prisma:generate:all`
- [ ] Update CreateDto
- [ ] Update UpdateDto
- [ ] Update ResponseDto
- [ ] Update DataSources
- [ ] Update Use Case validation (if tenant-specific)
- [ ] Add tests
