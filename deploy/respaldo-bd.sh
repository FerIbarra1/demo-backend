#!/usr/bin/env bash
# Respaldo lógico de la BD (pg_dump comprimido) con retención. Neon ya hace respaldos y restauración a un punto en el
# tiempo; este es el respaldo PROPIO, para tenerlo fuera de Neon (antes de una migración o una presentación).
#   DIRECT_DATABASE_URL="postgresql://…(host SIN -pooler)…" ./deploy/respaldo-bd.sh [carpeta] [dias_a_conservar]
# Usa la conexión DIRECTA: PgBouncer (la del pooler) no soporta pg_dump. Requiere `pg_dump` ≥ la versión del servidor.
set -euo pipefail
: "${DIRECT_DATABASE_URL:?define DIRECT_DATABASE_URL (la conexión DIRECTA, sin -pooler)}"
DESTINO="${1:-./respaldos}"; DIAS="${2:-14}"
mkdir -p "$DESTINO"
ARCHIVO="$DESTINO/ptm-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --no-privileges --format=plain "$DIRECT_DATABASE_URL" | gzip -9 > "$ARCHIVO.tmp"
mv "$ARCHIVO.tmp" "$ARCHIVO"                      # nunca queda un archivo a medias con nombre definitivo
find "$DESTINO" -name 'ptm-*.sql.gz' -mtime +"$DIAS" -delete
echo "Respaldo: $ARCHIVO ($(du -h "$ARCHIVO" | cut -f1))"
# Restaurar (en una BD VACÍA):  gunzip -c respaldos/ptm-AAAAMMDD-HHMMSS.sql.gz | psql "$DIRECT_DATABASE_URL"
