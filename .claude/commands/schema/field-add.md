---
description: Add new field(s) to existing Prisma model for both tenants
model: claude-sonnet-4-5
---

# Add Field to Schema - NOVA Microservicio Autos

Add new field(s) to an existing Prisma model, handling multi-tenant considerations.

## Field Details

$ARGUMENTS

## Implementation Workflow

### 1. Determine Field Scope

- **Shared field**: Add to BOTH Liverpool and Suburbia schemas
- **Liverpool-only**: Add only to `prisma/liverpool/schema.prisma`
- **Suburbia-only**: Add only to `prisma/suburbia/schema.prisma`

### 2. Prisma Field Syntax

```prisma
// Required field
fieldName    String

// Optional field
fieldName    String?

// With default
fieldName    Boolean  @default(false)

// Decimal with precision
price        Decimal  @db.Decimal(10, 2)

// Unique constraint
vin          String?  @unique

// With index
@@index([fieldName])
```

### 3. Update Schemas

**Liverpool (prisma/liverpool/schema.prisma):**

```prisma
model {{Model}} {
  // ... existing fields ...

  // NEW FIELD
  newField    Type    @default(value)

  // ... timestamps ...
}
```

**Suburbia (prisma/suburbia/schema.prisma):**

```prisma
model {{Model}} {
  // ... existing fields ...

  // NEW FIELD (if shared)
  newField    Type    @default(value)

  // ... timestamps ...
}
```

### 4. Update DTOs

**Create DTO:**

```typescript
// If required field
@ApiProperty({ description: 'Field description' })
@IsString()
@IsNotEmpty()
newField: string;

// If optional field
@ApiPropertyOptional({ description: 'Field description' })
@IsOptional()
@IsString()
newField?: string;
```

**Update DTO:**

```typescript
// Already inherits from PartialType(CreateDto)
// No changes needed unless special handling
```

**Response DTO:**

```typescript
@ApiProperty()
newField: string;
// or
@ApiPropertyOptional()
newField?: string;
```

### 5. Update DataSources

If the field is **tenant-specific**, update the create method:

```typescript
// Liverpool DataSource
async create(dto: CreateEntityDto) {
  const data = {
    // ... existing fields ...
    newLiverpoolField: dto.newLiverpoolField,
  };
  return this.prisma.entity.create({ data });
}

// Suburbia DataSource
async create(dto: CreateEntityDto) {
  const data = {
    // ... existing fields ...
    newSuburbiaField: dto.newSuburbiaField,
  };
  return this.prisma.entity.create({ data });
}
```

### 6. Update Use Case (if tenant-specific)

```typescript
private buildLiverpoolPayload(dto: CreateEntityDto) {
  const { suburbiaOnlyField, ...liverpoolData } = dto;
  return {
    ...liverpoolData,
    newLiverpoolField: dto.newLiverpoolField,
  };
}
```

### 7. Commands to Run

```bash
# Push schema changes to databases
npm run prisma:push:all

# Regenerate Prisma clients
npm run prisma:generate:all

# Restart dev server
npm run start:dev
```

### 8. Checklist

- [ ] Schema updated for correct tenant(s)
- [ ] CreateDto updated with validation
- [ ] ResponseDto updated
- [ ] DataSource(s) handle new field
- [ ] Use Case handles tenant-specific logic (if applicable)
- [ ] Prisma clients regenerated
- [ ] Tested both tenants

## Implement the field addition following this workflow.
