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

RUN apk upgrade --no-cache \
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
