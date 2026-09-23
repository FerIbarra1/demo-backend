# prisma/sql — SQL que Prisma no puede expresar

Estos archivos **ya no se aplican a mano**. Su contenido está formalizado como
migraciones en `prisma/migrations/`, así que `prisma migrate deploy` los aplica
en cualquier entorno nuevo. Se conservan aquí como documentación del *por qué*.

| Archivo | Contenido | Migración que lo aplica |
|---|---|---|
| `f13_propuesta_pendiente_unica.sql` | Índice único parcial en `pedidos_propuestas` | `20260922000100_indices_parciales` |
| `f15_chat_lectura.sql` | Watermarks de lectura del chat (3 columnas en `pedidos`) | `20260922000000_init` |

## Por qué existían

El proyecto usaba `prisma db push` en vez de migraciones, así que las cosas que
el schema no puede expresar (índices parciales con `WHERE`) había que aplicarlas
a mano en cada entorno. Eso produjo drift entre local y Neon.

Desde sep 2026 el proyecto usa migraciones versionadas. **No apliques estos
archivos manualmente**: ya están incluidos en la cadena.

## Si necesitas un índice parcial nuevo

1. Añade el `CREATE INDEX` a una migración nueva en `prisma/migrations/`
   (no a `prisma/sql/`).
2. Documenta aquí por qué el schema no lo puede expresar.
