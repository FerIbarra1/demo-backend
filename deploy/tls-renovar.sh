#!/usr/bin/env bash
# Renovación del certificado (cron mensual, p. ej. `0 4 1 * * cd /opt/ptm && ./deploy/tls-renovar.sh >> /var/log/ptm-tls.log 2>&1`).
# Certbot solo renueva si faltan <30 días. Con `standalone` necesita el puerto 80, así que nginx se detiene unos segundos;
# el `trap` lo vuelve a levantar pase lo que pase (también al reiniciarlo toma el certificado nuevo).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"
$COMPOSE stop nginx
trap '$COMPOSE start nginx' EXIT
docker run --rm -p 80:80 -v ptm_certs:/etc/letsencrypt certbot/certbot renew --standalone --non-interactive
