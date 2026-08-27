FROM node:22-alpine AS base
WORKDIR /app

# --- BUILDER STAGE ---
FROM base AS builder
# Install native build dependencies for 'canvas' and 'better-sqlite3'
RUN apk add --no-cache \
    python3 make g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

COPY package*.json ./
COPY prisma ./prisma/

# Use BuildKit cache for npm to speed up repeated builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci && npx prisma generate

COPY . .
RUN npm run build

# --- DEPENDENCIES STAGE (Clean production modules) ---
FROM base AS deps
RUN apk add --no-cache \
    python3 make g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

COPY package*.json ./
COPY prisma ./prisma/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && npx prisma generate

# --- RUNTIME STAGE ---
FROM base AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules

# Дата патчей базового образа. Сборка идёт с `cache-from: type=gha`, и слой с
# `apk upgrade` переиспользуется, пока НИ ОДНА строка выше не изменилась, —
# то есть патчи Alpine замораживаются в кеше, а сканер ECR винит свежий
# коммит. Так деплой 27.08.2026 встал на openssl 3.5.7-r0, хотя в
# репозиториях уже лежал 3.5.8-r0.
#
# Правка этой даты инвалидирует слой и заставляет apk пойти в сеть. Менять её
# при блокировке деплоя сканером; перезапуск джоба не поможет — нужен именно
# НОВЫЙ коммит.
ARG APK_PATCH_LEVEL=2026-08-27

# `apk upgrade` идёт первым и обновляет индекс, чтобы `apk add` ниже ставил
# пакеты из ТОГО ЖЕ свежего индекса, а не из старого снимка репозиториев.
RUN apk --no-cache upgrade \
    && apk add --no-cache ca-certificates cairo pango libjpeg-turbo giflib librsvg

# Copy artifacts from previous stages
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
COPY package.json ./
COPY prisma ./prisma/

# Standard Telegram Bot stop signal
STOPSIGNAL SIGINT

EXPOSE 8080

CMD ["npm", "start"]
