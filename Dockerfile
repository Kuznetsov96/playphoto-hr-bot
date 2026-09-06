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
#
# 29.08.2026: то же самое повторилось с giflib. Деплой встал на
# CVE-2026-26740 (HIGH, CVSS 8.2) в giflib 5.2.2-r1, хотя в 3.22-main уже
# лежал 5.2.2-r2 с исправлением.
#
# 06.09.2026: и снова, теперь util-linux. Деплой встал на четыре HIGH —
# CVE-2026-78408, -78409, -78410 и -76642 (CVSS до 8.5) в util-linux
# 2.42.1-r0, хотя в v3.24/main уже лежал 2.42.3-r1.
ARG APK_PATCH_LEVEL=2026-09-06

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
