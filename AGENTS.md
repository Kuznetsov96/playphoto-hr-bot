# AGENTS.md

## Project Overview

TypeScript ESM Telegram HR bot built with grammY, Prisma/PostgreSQL, Redis/BullMQ, Awilix DI, Pino logging, and Vitest.

Main entry point: `src/main.ts`. Production output is `dist/`.

## Important Folders

- `src/`: application code.
- `src/core/`: bot setup, DI container, Redis, queues, logging, sessions.
- `src/handlers/`: Telegram handlers and admin flows.
- `src/services/`: business logic; services should not depend on grammY `ctx`.
- `src/repositories/`: Prisma data access.
- `src/modules/`: newer domain modules for candidate and staff flows.
- `src/constants/`: user-visible text constants.
- `src/__tests__/`, `src/**/__tests__/`: Vitest tests.
- `prisma/`: schema, seed, and migrations.
- `scripts/`, `ops/`: operational and migration scripts.
- `docs/`: operational documentation.

## Commands

```bash
npm run dev
npm run build
npm test
npm run check-cycles
npm run check-menu-ids
npx prisma generate
npx prisma migrate dev --name <name>
```

CI runs Prisma generate/migrate checks, `npm run build`, `npm run check-cycles`, `npm run check-menu-ids`, and `npm test`.

## Coding Rules

- Keep admin UI text in English; staff/candidate-facing text is Ukrainian.
- Put admin strings in `src/constants/admin-texts.ts`; candidate strings in `src/constants/candidate-texts.ts`.
- Preserve ESM TypeScript style and existing DI patterns.
- Register services and repositories in `src/core/container.ts`.
- For schema changes, commit `prisma/schema.prisma` and the generated migration together. Do not use `prisma db push` for production.
- For menu flows, prefer `ScreenManager` helpers instead of direct menu replies/edits.

## Safety

- Do not push directly to `main`. Work through `dev` and PR to `main`.
- Do not edit generated output in `dist/`.
- Do not read or modify secrets unless explicitly required.
- Treat production/deploy scripts, migrations, backups, and logging configs as sensitive operational files.

## Avoid Reading Unless Needed

`node_modules/`, `dist/`, `.venv/`, `logs/`, `backups/`, `tmp/`, coverage/cache folders, local `.env*`, and generated Prisma output.

