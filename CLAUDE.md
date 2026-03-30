# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Git Workflow Rules

### CRITICAL: Never push directly to main

**All work must go through dev branch:**

1. Make changes in `dev`
2. Push to `origin/dev`
3. Create PR from `dev` → `main` (or merge via PR)
4. CI must pass before merge

**NEVER run:**
- `git push origin main`
- `git merge dev` while on `main` and then push
- Any direct commit to `main`

This applies to ALL LLMs and contributors without exception.

### Branch structure

- `dev` — active development, CI runs tests only
- `main` — production, triggers full CI + Docker build + deploy to server

### Deploy procedure

When the user asks to deploy (e.g. "deploy", "задеплой", "/deploy"):

1. Ensure all local changes are committed and pushed to `dev`
2. Create PR: `gh pr create --base main --head dev --title "..." --body "..."`
3. Wait for CI to pass: poll `gh pr checks <PR_NUMBER>` every 15s until all green
4. Merge: `gh pr merge <PR_NUMBER> --merge --delete-branch=false`
5. Confirm deploy started: `gh run list --branch main --limit 3`

Do NOT use `git merge` + `git push origin main` directly.

---

## Commands

```bash
# Development
npm run dev              # Run bot with nodemon (hot reload via tsx)

# Build & Production
npm run build            # tsc compile to dist/
npm run start            # prisma migrate deploy + node dist/main.js

# Testing
npm test                 # vitest run (all tests)
npm run test:coverage    # vitest run --coverage

# Code Quality
npm run check-cycles     # Detect circular dependencies (madge)
npm run check-menu-ids   # Validate grammY menu IDs are unique

# DB
npx prisma migrate dev --name <name>   # Create migration + apply
npx prisma migrate deploy              # Apply pending migrations (prod)
npx prisma studio                      # Visual DB editor
```

Tests live in `src/services/__tests__/` and `src/__tests__/`. Run a single test file:
```bash
npx vitest run src/services/__tests__/bootstrap.test.ts
```

---

## Architecture

### Stack
- **grammY** Telegram bot framework (TypeScript, ESM `"type": "module"`)
- **Prisma** ORM + **PostgreSQL** (Docker service `postgres`)
- **Redis** for sessions + BullMQ job queues (Docker service `redis`)
- **Awilix** dependency injection container (`src/core/container.ts`)
- **Pino** structured logging (`src/core/logger.ts`)
- **Zod** for all external data validation

### Entry point & middleware order (`src/main.ts`)
`main.ts` registers global middleware only — no business logic. Order matters:
1. Global error handler / logger
2. Rate limiter / flood protection
3. Lazy sessions (Redis-backed, RAM-cached with debounce)
4. Menus & plugins
5. Named commands (`/start`, `/admin`, `/hr`, `/mentor`)
6. Catch-all handlers (last)

### Directory structure

```
src/
  core/           # Infrastructure: bot.ts, container.ts, logger.ts, redis.ts, session.ts, queue.ts
  handlers/
    admin/        # Admin panel menus and flows (English UI)
    hr.ts         # HR hub handler
    mentor.ts     # Mentor hub handler
    support.ts    # Support tickets
    booking.ts    # Slot booking
    onboarding-handler.ts
  services/       # Business logic (no ctx — accept plain data, return results)
  workers/        # Background jobs (independent loops; errors must not crash main bot)
  repositories/   # DB access layer (Prisma queries)
  modules/
    staff/        # Staff sub-module (services + repositories)
    candidate/    # Candidate sub-module
  constants/
    admin-texts.ts      # All admin UI strings (English)
    candidate-texts.ts  # Candidate-facing strings (Ukrainian)
    staff-texts.ts
  types/
    context.ts    # MyContext — extended grammY context type
    di.ts         # Awilix Cradle type
  menus/          # grammY menu definitions
  views/          # Message formatting helpers
```

### Key architectural patterns

**SMI (Single Message Interface):** All navigation uses `editMessageText` through `ScreenManager`. Never call `ctx.editMessageText` or `ctx.reply` directly in menus — use `ScreenManager.renderScreen(ctx, text, menu, { pushToStack: true })`. Back navigation uses `ScreenManager.goBack(ctx, fallbackText, fallbackMenu)` which reads `navStack` from session.

**State machine sessions:** Multi-step flows use `ctx.session.step` (state machine), not `@grammyjs/conversations`. Reset step to `"idle"` on completion or cancellation.

**Services contract:** Services receive plain data (userId, text, etc.) — never `ctx`. They must be idempotent and atomic (use `$transaction` for multi-entity writes).

**DI container:** All services and repositories are registered in `src/core/container.ts` (Awilix). Access via `di.cradle.serviceName` or handler injection.

**Workers:** Each worker runs in an independent loop with `try-catch` inside the `for` loop so a single failure (e.g. blocked bot) doesn't stop the broadcast. Notification flags (e.g. `reminded6h`) are set in DB only **after** successful Telegram API call.

### Database schema changes
⚠️ Changing `schema.prisma` without a migration causes **Prisma Schema Drift** and breaks CI.

Always:
1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name <description>` (requires live DB connection)
3. Commit `schema.prisma` + `prisma/migrations/` + `migration_lock.toml` atomically

Never use `prisma db push` in production. Never create migration SQL files manually.

If the DB is unavailable, warn the user to run `migrate dev` themselves after your schema edits.

---

## UI Language Rules

- **Admin panel** (buttons, statuses, logs): **English**
- **Staff/Candidate-facing** text: **Ukrainian**
- All admin text constants go in `src/constants/admin-texts.ts`
- Candidate texts go in `src/constants/candidate-texts.ts`
- User-visible strings use Fluent (`src/locales/uk.ftl`) accessed via `ctx.t("key", { params })`

## Role Permissions

| Menu | Roles |
|------|-------|
| `/start` Admin Panel | SUPER_ADMIN, CO_FOUNDER |
| `/hr` HR Hub | SUPER_ADMIN, HR_LEAD |
| `/mentor` Mentor Hub | SUPER_ADMIN, MENTOR_LEAD |
| 👥 Team | SUPER_ADMIN, CO_FOUNDER, SUPPORT |
| 💰 Finance | SUPER_ADMIN, CO_FOUNDER, SUPPORT |
| 📦 Logistics | SUPPORT |
| Finance: Balances/Sync/Audit | SUPER_ADMIN only |
| HR: Final Step Pipeline | SUPER_ADMIN only |

## Regression Checklist

Before every commit:
1. **Menu shadowing** — does a new `bot.on("message")` intercept existing dialog steps?
2. **State pollution** — does the new code mutate `ctx.session.step` in ways that break other flows?
3. **Circular deps** — run `npm run check-cycles` if adding new imports
4. **Menu IDs** — run `npm run check-menu-ids` if adding new grammY menus; register submenus with `.register(subMenu)`
5. **Enum sync** — new statuses must be added to `schema.prisma` enums, not used as magic strings
6. **Broadcast safety** — notification loops must filter by explicit status (e.g. `status === 'AWAITING_FIRST_SHIFT'`), not only by boolean flags

## Docker notes

- Container-to-container URLs: use service names `postgres` and `redis`, never `localhost`
- `docker-compose.yml` `environment:` section overrides `.env` values for container networking
- `postgres` container is NOT restarted on bot deploys — data persists in Docker volume
