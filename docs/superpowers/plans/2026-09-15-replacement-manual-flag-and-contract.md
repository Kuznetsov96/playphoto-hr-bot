# Явна ознака ручної заявки і зняття `workShiftId` — етап 2.3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Ручна заявка» стає явною властивістю рядка (`isManual`), а не побічним наслідком порожнього `workShiftId`, після чого локальне поле знімається зі схеми.

**Architecture:** Expand/contract у трьох PR. A — колонка з бекфілом у тій самій міграції й подвійний запис. B — перенесення двох часткових унікальних індексів і гілки фільтра на нову ознаку. C — `DROP COLUMN workShiftId` після перевірки передумови на проді.

**Tech Stack:** TypeScript, Prisma, PostgreSQL, grammY, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-replacement-manual-flag-and-contract-design.md`

## Global Constraints

- Коментарі та докблоки — українською (AGENTS.md).
- **159 живих заявок з відкритими оферами в Telegram не мають осиротіти.** `DROP COLUMN` незворотний: revert поверне код, але не дані.
- Три часткові унікальні індекси створені сирим SQL поза моделлю Prisma (`prisma/migrations/20260607191500_restrict_active_replacement_uniqueness/migration.sql`). Prisma про них не знає й може спробувати «вирівняти» — міграції генерувати ТІЛЬКИ з `--create-only` і читати SQL очима.
- `ReplacementRequest_active_requester_location_date_key` не чіпати: він спирається на `requesterStaffId`, а не на `workShiftId`.
- Міграції вперше по-справжньому застосовуються на проді (`migrate deploy` у `package.json:13` і `deploy-aws-production.yml:212`).
- Повний прогін зеленим: база на 15.09.2026 — 1044 файли / 6873 тести.
- Тест-раннер: `npx vitest run <шлях>`; типи: `npx tsc --noEmit`.

---

### Task 1: Колонка `isManual` з бекфілом (PR A, схема)

**Files:**
- Modify: `prisma/schema.prisma` (модель `ReplacementRequest`, поле поряд із `workShiftId`)
- Create: `prisma/migrations/<timestamp>_replacement_request_is_manual/migration.sql`

**Interfaces:**
- Produces: поле `ReplacementRequest.isManual Boolean @default(false)`, заповнене для наявних рядків.

- [ ] **Step 1: Додати поле в схему**

У `prisma/schema.prisma`, у моделі `ReplacementRequest`, під `scheduledShiftPublicId`:

```prisma
  /// Ручна заявка адміністратора: пошук підміни на локацію й день, коли зміни
  /// в графіку немає взагалі. Раніше цю роль грав порожній `workShiftId`, але
  /// у звичайної заявки, якої дзеркало ще не звʼязало з каноном, він теж
  /// порожній — і вона хибно сходила за ручну.
  isManual Boolean @default(false)
```

- [ ] **Step 2: Згенерувати міграцію**

Run: `npx prisma migrate dev --name replacement_request_is_manual --create-only`

- [ ] **Step 3: Перевірити й доповнити SQL**

Відкрити створений `migration.sql`. Він має містити рівно один `ADD COLUMN`:

```sql
ALTER TABLE "ReplacementRequest" ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT false;
```

**Дописати в той самий файл бекфіл** одразу під ним:

```sql
UPDATE "ReplacementRequest" SET "isManual" = true WHERE "workShiftId" IS NULL;
```

Бекфіл саме тут, а не окремим скриптом: розрив між створенням колонки й заповненням лишив би вікно, у якому ручна заявка виглядає звичайною.

Якщо у згенерованому SQL є БУДЬ-ЩО ще — `DROP`, зміни індексів, згадки `ReplacementRequest_active_*` — ЗУПИНИТИСЬ, повернути BLOCKED і навести повний текст.

- [ ] **Step 4: Застосувати локально**

Run: `npx prisma migrate dev`
Run: `npx tsc --noEmit`
Expected: типи чисті, поле є в клієнті.

- [ ] **Step 5: Коміт**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(replacements): явна ознака ручної заявки

Колонка isManual замість побічного смислу порожнього workShiftId. Бекфіл у
тій самій міграції: рядки без workShiftId — це рівно ручні заявки.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Проставляти `isManual` при створенні (PR A, код)

**Files:**
- Modify: `src/services/replacement-service.ts` (`startAdminRequest`, виклик `createActiveRequest`)
- Create: `src/services/__tests__/replacement-manual-flag.test.ts`

**Interfaces:**
- Consumes: поле з Task 1.
- Produces: заявки від `startAdminRequest` несуть `isManual: true`; від `startRequest` — `false` (дефолт схеми).

- [ ] **Step 1: Написати падаючий тест**

Створити `src/services/__tests__/replacement-manual-flag.test.ts`. За зразком моків узяти `src/services/__tests__/replacement-canonical-link.test.ts` (він уже мокає `startRequest` цілком, з `notifyAdminStarted`/`dispatchNextWave`).

Тест 1: `startAdminRequest(api, "loc-1", date)` → у `create.mock.calls[0][0].data` поле `isManual === true`.
Тест 2: `startRequest(api, "staff-1", "shift-1")` → `isManual` не встановлюється явно (`undefined`), тобто працює дефолт схеми `false`.

Для `startAdminRequest` знадобляться моки: `prisma.location.findUnique` (повертає локацію з `schedule`), `prisma.workShift.findFirst` → `null` (інакше кине `LOCATION_DAY_ALREADY_HAS_SHIFT`), `prisma.replacementRequest.findFirst` → `null`. Дату зміни взяти в майбутньому, інакше кине `SHIFT_ALREADY_STARTED`.

- [ ] **Step 2: Запустити — має падати**

Run: `npx vitest run src/services/__tests__/replacement-manual-flag.test.ts`
Expected: FAIL — `isManual` відсутній у `data`.

- [ ] **Step 3: Реалізувати**

У `startAdminRequest`, у виклик `this.createActiveRequest({ ... })` додати рядок:

```typescript
            isManual: true,
```

`startRequest` не чіпати: там працює дефолт `false`.

- [ ] **Step 4: Тести й типи**

Run: `npx vitest run src/services/__tests__/replacement-manual-flag.test.ts`
Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: усе зелене, +2 тести до бази.

- [ ] **Step 5: Коміт**

```bash
git add src/services/replacement-service.ts src/services/__tests__/replacement-manual-flag.test.ts
git commit -m "feat(replacements): startAdminRequest проставляє isManual

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Перенести індекси й фільтр на `isManual` (PR B)

**Files:**
- Create: `prisma/migrations/<timestamp>_replacement_indexes_on_manual_and_canonical/migration.sql`
- Modify: `src/services/replacement-service.ts` (`getSameReplacementSearchFilter`, гілка `else` ~рядок 1188)
- Modify: `src/services/__tests__/replacement-manual-flag.test.ts`

**Interfaces:**
- Consumes: `isManual` з Task 1-2.
- Produces: індекс ручних заявок спирається на `isManual`, індекс унікальності зміни — на `scheduledShiftPublicId`; фільтр «та сама заявка» відрізняє ручну за `isManual`.

**Що НЕ чіпати:** `ReplacementRequest_active_requester_location_date_key`; гілку `{ workShiftId: { in: localShiftIds } }` у `listSelectableShifts` (старі закриті заявки досі мають лише локальне поле — вона піде разом з колонкою в Task 4).

- [ ] **Step 1: Написати падаючий тест**

Додати в `src/services/__tests__/replacement-manual-flag.test.ts` тест на фільтр: заявка з `isManual: true` і `workShiftId: null` має знаходитись гілкою за `isManual`, а НЕ за порожнім `workShiftId`.

Ключовий тест цієї роботи (обовʼязковий): заявка з `isManual: false`, `workShiftId: null` і `scheduledShiftPublicId: null` — тобто звичайна заявка, якої дзеркало ще не звʼязало з каноном — НЕ має вважатись ручною.

`getSameReplacementSearchFilter` приватний; перевіряти через публічний шлях, який його викликає, або перевіряти аргументи `findFirst`/`findMany`, як це зроблено в `replacement-selectable-shifts.test.ts` (там перевіряються саме аргументи запиту — мок Prisma ігнорує `where`, і без такої перевірки тест зеленітиме на зламаній реалізації).

- [ ] **Step 2: Запустити — має падати**

Run: `npx vitest run src/services/__tests__/replacement-manual-flag.test.ts`
Expected: FAIL — фільтр досі дивиться на `workShiftId: null`.

- [ ] **Step 3: Створити міграцію індексів**

Створити порожню міграцію: `npx prisma migrate dev --name replacement_indexes_on_manual_and_canonical --create-only`

Вміст `migration.sql` написати вручну (Prisma цих індексів не знає, тож згенерує порожній файл):

```sql
DROP INDEX IF EXISTS "ReplacementRequest_active_manual_location_date_key";
CREATE UNIQUE INDEX "ReplacementRequest_active_manual_location_date_key"
ON "ReplacementRequest"("locationId", "shiftDate")
WHERE "status" = 'ACTIVE' AND "isManual" = true;

DROP INDEX IF EXISTS "ReplacementRequest_active_workShiftId_key";
CREATE UNIQUE INDEX "ReplacementRequest_active_scheduled_shift_key"
ON "ReplacementRequest"("scheduledShiftPublicId")
WHERE "status" = 'ACTIVE' AND "scheduledShiftPublicId" IS NOT NULL;
```

- [ ] **Step 4: Перемкнути фільтр**

У `getSameReplacementSearchFilter` гілку `else` (~рядок 1188) перевести з `workShiftId: null` на `isManual: true`. Дописати український коментар, що ознака тепер явна.

- [ ] **Step 5: Застосувати й перевірити**

Run: `npx prisma migrate dev`
Run: `npx vitest run src/services/__tests__/replacement-manual-flag.test.ts`
Run: `npx tsc --noEmit`
Run: `npx vitest run`

- [ ] **Step 6: Коміт**

```bash
git add prisma/migrations src/services/replacement-service.ts src/services/__tests__/replacement-manual-flag.test.ts
git commit -m "feat(replacements): індекси й фільтр на явній ознаці ручної заявки

Унікальність ручних заявок тепер спирається на isManual, унікальність пошуку
на зміну — на канонічний id. Порожній workShiftId більше не несе смислу.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Зняти `workShiftId` (PR C)

**Files:**
- Modify: `prisma/schema.prisma` (прибрати поле `workShiftId` і звʼязок `workShift`)
- Modify: `src/services/replacement-service.ts` (останні згадки)
- Create: `prisma/migrations/<timestamp>_replacement_drop_work_shift_id/migration.sql`

**ПЕРЕДУМОВА — ця задача НЕ починається без підтвердження контролера.** Перед нею на проді виконується запит нижче, і його результат має бути нуль. Контролер показує результат користувачу й лише тоді дає старт.

```sql
SELECT count(*) FROM "ReplacementRequest"
WHERE status IN ('ACTIVE','FOUND') AND "workShiftId" IS NOT NULL AND "scheduledShiftPublicId" IS NULL;
```

- [ ] **Step 1: Прибрати згадки з коду**

У `src/services/replacement-service.ts` прибрати `workShiftId` з:
- фільтра блокувань у `listSelectableShifts` (гілка `{ workShiftId: { in: localShiftIds } }`, `select`, і збірка `blockedShiftIds`)
- `startRequest` (передача при створенні, перевірка `{ workShiftId: shift.id }` в `existing`)
- `reconcileRequestsChangedBySchedule` (умова й `data`)
- `getSameReplacementSearchFilter` (гілка `if (request.workShiftId)`)
- решти місць, які покаже `rg -n "workShiftId" src/`

Логіка скрізь переходить на `scheduledShiftPublicId`. Якщо десь виявиться, що канонічного поля недостатньо — ЗУПИНИТИСЬ і повернути BLOCKED з описом, не вигадувати обхід.

- [ ] **Step 2: Прибрати зі схеми**

У `prisma/schema.prisma` прибрати рядок `workShiftId String?` і звʼязок `workShift WorkShift? @relation(...)` з моделі `ReplacementRequest`.

**Зустрічне поле — тільки в `WorkShift`** (`schema.prisma:520`, `replacementRequests ReplacementRequest[]`). У схемі є ще два поля з такою самою назвою — у `Location` (рядок 298) і `StaffProfile` (рядок 448, `@relation("ReplacementRequester")`). Вони належать іншим звʼязкам, їх НЕ чіпати.

- [ ] **Step 3: Згенерувати міграцію**

Run: `npx prisma migrate dev --name replacement_drop_work_shift_id --create-only`

Перевірити SQL: має бути `DROP COLUMN "workShiftId"` і, можливо, зняття FK. Переконатись, що індекси `ReplacementRequest_active_manual_location_date_key`, `ReplacementRequest_active_scheduled_shift_key` і `ReplacementRequest_active_requester_location_date_key` НЕ згадуються. Якщо згадуються — BLOCKED.

- [ ] **Step 4: Тести й типи**

Run: `npx prisma migrate dev`
Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: зелено. Тести, що спиралися на `workShiftId`, доведеться оновити — це очікувано; оновлювати на `scheduledShiftPublicId`, а не видаляти.

- [ ] **Step 5: Перевірити, що згадок не лишилось**

Run: `rg -n "workShiftId" src/ prisma/schema.prisma`
Expected: жодного збігу (окрім, можливо, історичних коментарів — їх теж прибрати).

- [ ] **Step 6: Коміт**

```bash
git add prisma/schema.prisma prisma/migrations src/
git commit -m "feat(replacements): зняти workShiftId із заявки на підміну

Заявка більше не залежить від локального рядка дзеркала: звʼязок тримає
канонічний scheduledShiftPublicId, ознака ручної заявки — isManual.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Покриття вимог зі спеки

| Вимога | Де |
|---|---|
| A: колонка `isManual` + бекфіл | Task 1 |
| A: подвійний запис ознаки | Task 2 |
| B: індекс ручних на `isManual` | Task 3, Step 3 |
| B: індекс зміни на `scheduledShiftPublicId` | Task 3, Step 3 |
| B: фільтр за `isManual` | Task 3, Step 4 |
| C: `DROP COLUMN` | Task 4 |
| Тест: звичайна заявка без канону ≠ ручна | Task 3, Step 1 (ключовий) |
| Передумова кроку C на проді | перед Task 4, виконує контролер |
