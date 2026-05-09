# PROJECT_MAP.md

## Purpose

Telegram HR bot for PlayPhoto hiring, staff logistics, onboarding, support, finance/admin workflows, reminders, and operational reporting.

## Structure

- `src/main.ts`: bootstraps bot, middleware, menus, commands, and handlers.
- `src/core/`: infrastructure: bot, DI, Redis, queues, logging, session, crypto.
- `src/handlers/`: Telegram interaction flows, including `handlers/admin/`.
- `src/services/`: business logic and integrations.
- `src/repositories/`: Prisma queries and persistence boundaries.
- `src/modules/candidate/`, `src/modules/staff/`: modular candidate/staff features.
- `src/constants/`: UI copy and domain constants.
- `src/utils/`, `src/views/`, `src/types/`, `src/schemas/`: shared helpers and types.
- `prisma/`: database schema, seed, and migrations.
- `scripts/`: one-off operations, migrations, diagnostics, and maintenance scripts.
- `ops/`: deploy and logging infrastructure.
- `docs/`: logging, ops, HR, and mentor documentation.

## Common Commands

```bash
npm run dev
npm run build
npm test
npm run check-cycles
npm run check-menu-ids
npx prisma generate
```

## Do Not Touch Casually

- `prisma/migrations/` and `prisma/schema.prisma`
- `ops/`, `docker-compose.yml`, `Dockerfile`, deploy scripts
- `.env*`, `google-service-account.json`, backup files
- `src/core/container.ts`, middleware order in `src/main.ts`
- Text constants that affect user-facing bot copy

## Generated or Local-Only

- `node_modules/`: dependencies.
- `dist/`: TypeScript build output.
- `.venv/`: local Python runtime.
- `logs/`: runtime logs.
- `backups/`: local encrypted database backups.
- `tmp/`: local scratch/diagnostic scripts.
- `coverage/`, `.cache/`: test/tool output.

