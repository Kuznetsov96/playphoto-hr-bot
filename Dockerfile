FROM node:22-bookworm-slim AS base
WORKDIR /app

# --- BUILDER STAGE ---
FROM base AS builder
# Install native build dependencies for 'canvas' and 'better-sqlite3'
RUN apt-get update && apt-get install -y \
    python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/

# Use BuildKit cache for npm to speed up repeated builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci && npx prisma generate

COPY . .
RUN npm run build

# --- DEPENDENCIES STAGE (Clean production modules) ---
FROM base AS deps
RUN apt-get update && apt-get install -y \
    python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && npx prisma generate

# --- RUNTIME STAGE ---
# Install only Chromium and its runtime libraries. The full Playwright image also
# ships Firefox/WebKit multimedia stacks that this bot never executes.
FROM base AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=deps /app/node_modules ./node_modules

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl zip libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    && npx playwright install-deps chromium \
    && npx playwright install chromium \
    && rm -rf /var/lib/apt/lists/*

# Copy artifacts from previous stages
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts ./scripts
COPY package.json ./
COPY prisma ./prisma/

# Since versions match, browsers are already in the image!
# No need for: RUN npx playwright install chromium

# Standard Telegram Bot stop signal
STOPSIGNAL SIGINT

EXPOSE 8080

CMD ["npm", "start"]
