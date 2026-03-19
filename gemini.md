# Gemini Instructions for PlayPhoto HR Bot

You are working as an AI coding assistant on the PlayPhoto HR Bot (Node.js + grammY + Prisma).

**CRITICAL INSTRUCTION:**
Before writing any code, planning architecture, or modifying database schemas, you **MUST ALWAYS** read and strictly follow the comprehensive rules defined in `ENGINEERING_GUIDELINES.md`.

## Key Project Rules & Constraints:
1. **SMI (Single Message Interface) & ScreenManager:** Do not use `ctx.reply` or `ctx.editMessageText` directly in menus. ALWAYS use `ScreenManager.renderScreen(ctx, ...)` for state transitions.
2. **Stateless Navigation:** Do not use `@grammyjs/conversations`. Menu states and candidate funnel steps are tracked via `ctx.session` (e.g., `ctx.session.step`, `ctx.session.candidateData`) and the database (`Candidate.status`).
3. **Database & Schema:** Any changes to `schema.prisma` MUST be accompanied by a generated migration (`npx prisma migrate dev`). Do not use `prisma db push` in production. Always use transaction `$transaction` for interrelated database changes.
4. **Imports:** The project uses ESM (`type: "module"`). All relative imports MUST end with `.js`.
5. **No Logic in `main.ts`:** `main.ts` is strictly for middleware ordering and handler registration. Create separate handler/service files for business logic.
6. **I18n (Fluent):** No hardcoded text. Use `ctx.t("key")` paired with `/src/locales/uk.ftl`. Admin texts are kept in `src/constants/admin-texts.ts`.

Read `ENGINEERING_GUIDELINES.md` for the full context on Docker architectures, broadcast safeties, role permissions, and safe git flows.
