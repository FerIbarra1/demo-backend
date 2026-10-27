# Despliegue y checklist de la presentación

**Render** (api, plan gratis) + **Neon** (Postgres) + **Vercel** (front). **Sin el agente del Sistema Comercial** en la
presentación (ver §6). Nada de esto se ha ejecutado contra Render, Neon ni Vercel reales: ver «Qué está probado».

```
navegador ──https──► app.tudominio.com (Vercel, front)
    └────https/wss──► api.tudominio.com (Render, Docker) ─► Neon (Postgres, pooler)
                                                         ├─► S3 (fotos públicas + comprobantes/DTF privados)
                                                         └─► SMTP (correos)
```

## 0. Render gratis y Neon gratis: qué cambia (léelo antes)

Verificado en la documentación de Render y Neon (oct-2026) o deducido del código; lo no verificado está marcado.

| # | Qué pasa | Efecto en la presentación | Qué hacer |
|---|---|---|---|
| 1 | Render **duerme** el servicio tras 15 min sin tráfico y tarda **~1 min** en despertar (512 MB de RAM, 0,1 CPU) | La primera visita tras un rato parece rota; los sockets se caen al dormir; los barridos programados no corren dormido | Despiértalo 10 min antes y mantenlo despierto con un monitor (UptimeRobot, gratis) a `/api/health/ready` cada 5 min mientras dure la demo |
| 2 | Neon **suspende** el cómputo a los 5 min sin uso y tarda unos segundos en despertar | La primera consulta puede fallar con «Can't reach database» | `connect_timeout=15` en `DATABASE_URL`; el mismo monitor de arriba (consulta la BD) lo mantiene despierto |
| 3 | `onrender.com` y `vercel.app` son sitios **distintos** (cross-site) | La cookie de refresh se trata como de terceros: Safari/iOS y Chrome con cookies de terceros bloqueadas **no la guardan** y el usuario pierde la sesión a la hora | **Dominio propio**: `app.tudominio.com` (Vercel) y `api.tudominio.com` (Render permite dominios propios; verifica que tu plan lo incluya). Sin dominio, pruébalo en Safari antes |
| 4 | **512 MB de RAM** y el análisis de archivos DTF lanza un proceso con tope de 2048 MB | Un PDF/PNG grande puede agotar la memoria y **reiniciar toda la api** | `DTF_PREFLIGHT_MEMORIA_MB=256` (ya va en `render.yaml`) y en la demo usa archivos pequeños |
| 5 | El plan gratis tiene disco **efímero** | Irrelevante: imágenes y comprobantes van a S3 (obligatorio en producción) | Nada, pero S3 debe estar configurado |
| 6 | Render pone sus balanceadores (y a veces Cloudflare) delante | Con `TRUST_PROXY_HOPS=1` (el defecto) la api puede ver la IP del balanceador y no la del cliente: los anónimos (login, TV) compartirían el límite de peticiones. **No verificado cuántos saltos hay** | En el primer despliegue compara la IP que ve la api con la tuya y ajusta `TRUST_PROXY_HOPS` (la recomendación de Render es 1; un valor mayor que el real permite falsificar `X-Forwarded-For`) |
| 7 | Las migraciones no pueden correr en el arranque del plan gratis (no confirmé si hay «pre-deploy command» en gratis) | — | Se aplican desde tu máquina contra Neon (§3) |
| 8 | CORS acepta **solo** `FRONTEND_URL` | Las URLs de *preview* de Vercel quedan bloqueadas | Presenta con el dominio de producción |

## 1. Antes de empezar

- **Dominio** con DNS editable (§0, fila 3).
- Las **credenciales ROTADAS** (las que pegaste en la conversación quedaron expuestas): contraseña SMTP/Gmail, claves
  de AWS y contraseña de Neon. No uses las viejas.
- Bucket S3 **público** (fotos) y, recomendado, otro **privado** (comprobantes bancarios y DTF). IAM mínimo: `.env.example`.

## 2. Variables

Backend (Render → Environment; `render.yaml` ya las declara): `.env.example` es la referencia. Obligatorias, o la api
**se niega a arrancar** y lista TODO lo que falta: `DATABASE_URL`, `DIRECT_DATABASE_URL`, `JWT_SECRET`, `KIOSKO_QR_SECRET`
(≥32 y distintos), `AGENT_API_KEY` (≥32), `FRONTEND_URL` (`https://app.tudominio.com`, **sin ruta**),
`SMTP_HOST/PORT/USER/PASS/FROM`, `AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION/S3_BUCKET`. `PORT` lo pone Render.
Secretos: `openssl rand -base64 48` (y `AGENT_API_KEY`: `openssl rand -hex 32`).

- `DATABASE_URL` = Neon **con** `-pooler` + `&sslmode=require&pgbouncer=true&connect_timeout=15`.
- `DIRECT_DATABASE_URL` = Neon **sin** `-pooler` (lo usan las migraciones y el respaldo).

Front (Vercel → Settings → Environment Variables; se incrustan al **compilar**): `NEXT_PUBLIC_API_URL=https://api.tudominio.com/api`,
`NEXT_PUBLIC_SITE_URL=https://app.tudominio.com`, `NEXT_PUBLIC_S3_HOST=<bucket>.s3.<región>.amazonaws.com`.
Sin `NEXT_PUBLIC_API_URL` el build **falla** a propósito.

## 3. Puesta en marcha

1. **Migrar Neon desde tu máquina** (con la conexión directa), en la rama que vas a desplegar:
   `DATABASE_URL="<directa>" DIRECT_DATABASE_URL="<directa>" pnpm exec prisma migrate deploy`
2. **Datos demo** (una vez, solo en la BD de la demo; el seed borra pedidos, kioskos y ventanillas, y actualiza catálogo y
   usuarios por su clave natural). El seed se niega por defecto contra una BD que no sea localhost; para una BD remota hay que
   nombrar su host (el de `<directa>`, sin puerto ni ruta):
   `SEED_BD_REMOTA_HOST="<host-directo>" DATABASE_URL="<directa>" DIRECT_DATABASE_URL="<directa>" pnpm prisma:seed`
3. **Render:** New → Blueprint (usa `render.yaml`) o Web Service manual: runtime *Docker*, `Dockerfile`, health check
   `/api/health`, plan Free; completa las variables. Deploy.
4. **Dominios:** en Render, `api.tudominio.com` (CNAME); en Vercel, `app.tudominio.com`. Después ajusta `FRONTEND_URL`.
5. **Verifica:** `curl https://api.tudominio.com/api/health/ready` → `{"status":"ok","db":"ok"}`.

**Actualizar:** si hay migraciones nuevas, primero el paso 1; después *Manual Deploy* en Render. **No existe rollback de
migraciones: respalda ANTES** (§5).

## 4. Operación

- Logs: panel de Render. Salud: `/api/health` (vivo, no toca la BD) y `/api/health/ready` (la BD responde).
- Estado en memoria **por proceso** (bloqueo de login por cuenta, límite de peticiones): hay UNA instancia; al
  reiniciarse o dormirse empieza de cero.

## 5. Respaldo

Neon respalda por su cuenta (y restaura a un punto en el tiempo). El propio, antes de migrar o de presentar:
`DIRECT_DATABASE_URL="…" ./deploy/respaldo-bd.sh ./respaldos 14` (pg_dump comprimido; requiere `pg_dump` ≥ la versión del
servidor). Restaurar en una BD **vacía**: `gunzip -c respaldos/ptm-….sql.gz | psql "$DIRECT_DATABASE_URL"`.

## 6. Sin el agente del Sistema Comercial: qué cambia en la presentación

El agente (Windows, en cada tienda) es lo que lleva los pedidos a Firebird y trae los cobros. Sin él:

| Funciona | No funciona / se ve distinto |
|---|---|
| Catálogo, registro/login, pedidos web y kiosko, bodega, mostrador, propuestas y asesor de ventas, DTF, transferencias hasta verificarlas en Tesorería, cancelaciones | Un pedido en **PENDIENTE_PAGO nunca recibe folio del ERP**: se nombra `PD-…` en pantallas, correos y TV (los turnos de 4 dígitos no existen) |
| **Marcar como pagado (manual)** del ADMIN: es la forma de avanzar un pedido a PAGADO/ENTREGADO en la demo | **No salen** los correos «listo para pagar» ni las instrucciones de transferencia (se mandan al ACK del agente); los datos de transferencia SÍ están en el detalle del pedido |
| | `/admin/salud` y `/gerencia/salud` mostrarán el agente **SIN LATIDO / NUNCA** y pedidos esperando al ERP en rojo: es lo esperado, avísalo para no asustar |

## 7. Checklist (el día anterior y antes de entrar)

- [ ] `https://api…/api/health/ready` responde `ok` y el candado de TLS es válido (también `app.`)
- [ ] El monitor (UptimeRobot) ya está pegando a `/api/health/ready` cada 5 min (Render y Neon despiertos)
- [ ] Iniciar sesión, **cerrar la pestaña, abrirla otra vez** y seguir con sesión (la cookie de refresh sobrevive; prueba en Safari)
- [ ] Login con un usuario de cada rol que vayas a enseñar; el cierre de sesión lleva a `/login`
- [ ] Registro de un cliente nuevo **con correo real**: llega el de bienvenida (comprueba SMTP)
- [ ] Subir una foto de producto desde `/admin`: se ve en el catálogo (S3 público + `NEXT_PUBLIC_S3_HOST`)
- [ ] Un pedido de punta a punta (cliente → bodega → mostrador → «Marcar como pagado» manual)
- [ ] TV de bodega abierta en otra pestaña: el pedido aparece **en vivo** (WebSocket por `wss://`)
- [ ] Subir un PDF/PNG de DTF y ver el semáforo de revisión (usa el worker del preflight)
- [ ] Un comprobante de transferencia subido y verificado en Tesorería (bucket privado)
- [ ] Respaldo de la BD hecho **hoy** (§5)

**Riesgos que conviene conocer:** las cuentas demo del seed usan la contraseña `123456` (ADMIN y TESORERÍA incluidas). Si
`api.`/`app.` son alcanzables desde internet, cambia al menos esas dos desde `/admin/usuarios` (el panel pide 8+ con letra
y número). El login tiene bloqueo por cuenta (10 fallos → 10 min) y límite por IP, pero una clave de seed es una clave
conocida.

## Alternativa: un VPS con Docker + nginx (NO es tu caso)

`docker-compose.prod.yml`, `deploy/nginx/`, `deploy/tls-inicial.sh` y `deploy/tls-renovar.sh` montan api + nginx + TLS
(Let's Encrypt) en un servidor propio, con `prisma migrate deploy` como paso de release. **Sin probar** (necesitan un
dominio y un servidor reales); se dejan por si algún día se migra de Render.

## Qué está probado y qué no

Probado en local contra una BD desechable: build de las dos imágenes (`api`: 973 MB, `migrar`: 1,96 GB), arranque de la
imagen `api` en modo producción con `PORT=10000` (salud, BD, Swagger oculto, login, CORS solo para `FRONTEND_URL`),
`validarEntorno` abortando con envs de ejemplo, el `preflight-worker.js` **dentro** de la imagen analizando un PNG real
(antes de este cambio `nest build` NO lo copiaba y todo análisis DTF habría fallado en un contenedor), y el usuario no root.
**No probado:** Render, Neon, Vercel, S3 ni SMTP reales, el despertar tras dormir, cuántos saltos de proxy hay en Render,
Safari/móvil, ni el agente contra el Firebird real.
