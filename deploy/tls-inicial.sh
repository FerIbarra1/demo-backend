#!/usr/bin/env bash
# Primer certificado de Let's Encrypt para la api. Corre ANTES de levantar nginx (necesita el puerto 80 libre).
#   DOMINIO_API=api.tudominio.com EMAIL=tu@correo.com ./deploy/tls-inicial.sh
# Requisito: el DNS de DOMINIO_API ya apunta a este servidor.
set -euo pipefail
: "${DOMINIO_API:?define DOMINIO_API}" "${EMAIL:?define EMAIL (avisos de vencimiento)}"
docker volume create ptm_certs >/dev/null
docker run --rm -p 80:80 -v ptm_certs:/etc/letsencrypt certbot/certbot certonly \
  --standalone -d "$DOMINIO_API" --agree-tos -m "$EMAIL" --non-interactive
echo "Certificado emitido. Ahora: docker compose -f docker-compose.prod.yml up -d --build"
