# syntax=docker/dockerfile:1.7
#
# Backend NestJS 11 + Prisma 6. Multi-stage:
#   deps    → dependencias (todas) con el lockfile congelado
#   build   → prisma generate + nest build
#   migrar  → trabajo de RELEASE: `prisma migrate deploy` (lleva el CLI de Prisma, que es devDependency)
#   podado  → build sin devDependencies
#   api     → imagen final: solo dist + node_modules de producción, sin root, con HEALTHCHECK
#
#   docker build --target api    -t ptm-api .
#   docker build --target migrar -t ptm-migrar .
ARG NODE_VERSION=24
ARG PNPM_VERSION=12.14.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV CI=true
# openssl: los motores de Prisma lo exigen y la imagen slim no lo trae. ca-certificates: TLS hacia S3, SMTP y la BD.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

FROM base AS deps
# python3/make/g++: red de seguridad por si `bcrypt` o `sharp` no encuentran un binario precompilado y compilan desde fuente.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
# `build` = prisma generate && nest build. nest-cli.json copia `preflight-worker.js` (un .js suelto que tsc no emite).
RUN pnpm run build

# ── Release: aplica las migraciones pendientes (idempotente). Necesita DATABASE_URL y DIRECT_DATABASE_URL. ──
FROM build AS migrar
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM build AS podado
RUN pnpm prune --prod

# ── Imagen final ──
FROM base AS api
ENV NODE_ENV=production \
    PORT=3000
COPY --from=podado --chown=node:node /app/node_modules ./node_modules
COPY --from=podado --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# El disco local (uploads/, storage-privado/) es SOLO un respaldo de desarrollo: en producción todo va a S3.
USER node
EXPOSE 3000
# Liveness (el proceso responde). NO toca la BD a propósito: si la BD se cae, reiniciar el contenedor no la arregla.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main"]
