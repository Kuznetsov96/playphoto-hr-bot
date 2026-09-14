# Звʼязок заявки на підміну з канонічним ідентифікатором — етап 2 (кроки 2.1 і 2.2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ReplacementRequest` несе канонічний `scheduledShiftPublicId` поряд із локальним `workShiftId`, наявні заявки заповнені бекфілом, а читання віддає перевагу канонічному полю.

**Architecture:** Expand/contract без кроку contract. Спершу адитивна міграція додає nullable-поле й код пише обидва (2.1). Далі бекфіл заповнює наявні рядки через `WorkShift.awsScheduledShiftPublicId` (він `@unique`), а читання перемикається на нове поле зі старим як запасним (2.2). Зняття `workShiftId` (2.3) у цей план НЕ входить.

**Tech Stack:** TypeScript, Prisma, PostgreSQL, grammY, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-replacement-picker-canonical-design.md`

## Global Constraints

- Коментарі та докблоки — українською; адмінські тексти англійською (AGENTS.md).
- **Живі заявки не можна осиротити.** «Жива» — статус `ACTIVE` або `FOUND`: у них відкриті офери в Telegram у реальних людей.
- **Крок 2.3 (зняття `workShiftId`) не робити.** Поле лишається, звʼязок `workShift` лишається, жодного `DROP COLUMN`.
- Міграції в цьому проєкті вперше по-справжньому застосовуються на проді (`npx prisma migrate deploy` у `package.json:13` і `deploy-aws-production.yml:212`). Локальний зелений прогін цього не доводить — міграція має бути адитивною й безпечною при повторному застосуванні.
- **Три часткові унікальні індекси створені сирим SQL**, а не моделлю Prisma (`prisma/migrations/20260607191500_restrict_active_replacement_uniqueness/migration.sql`). Два з них спираються на `workShiftId`. Їх не чіпати: вони — захист від двох одночасних пошуків на одну зміну.
- Повний прогін має лишатись зеленим: база на момент написання — 1042 файли / 6866 тестів.
- Тест-раннер: `npx vitest run <шлях>`; типи: `npx tsc --noEmit`.

---

### Task 1: Додати поле `scheduledShiftPublicId` (крок 2.1, схема)

**Files:**
- Modify: `prisma/schema.prisma` (модель `ReplacementRequest`, ~рядок 556)
- Create: `prisma/migrations/<timestamp>_replacement_request_scheduled_shift_public_id/migration.sql`

**Interfaces:**
- Produces: поле `ReplacementRequest.scheduledShiftPublicId String?` — його читають і пишуть усі наступні задачі.

Чому nullable і без унікального індексу: наявні рядки поки порожні (заповнить Task 3), а унікальність активних заявок уже забезпечують часткові індекси на `workShiftId`, які лишаються на місці.

- [ ] **Step 1: Додати поле в схему**

У `prisma/schema.prisma`, у моделі `ReplacementRequest`, одразу під рядком `workShiftId        String?` додати:

```prisma
  /// Канонічний ідентифікатор зміни. Заповнюється поряд із workShiftId, щоб
  /// заявка перестала залежати від локального рядка дзеркала. Nullable, доки
  /// живуть заявки, створені до переходу.
  scheduledShiftPublicId String?
```

- [ ] **Step 2: Згенерувати міграцію**

Run: `npx prisma migrate dev --name replacement_request_scheduled_shift_public_id --create-only`

Прапорець `--create-only` обовʼязковий: міграцію треба прочитати очима до застосування.

- [ ] **Step 3: Перевірити згенерований SQL**

Відкрити створений `migration.sql`. Він має містити РІВНО один `ALTER TABLE ... ADD COLUMN`, і більше нічого.

Expected:
```sql
ALTER TABLE "ReplacementRequest" ADD COLUMN "scheduledShiftPublicId" TEXT;
```

Якщо там є будь-який `DROP`, `ALTER ... DROP COLUMN`, або зміни трьох часткових унікальних індексів (`ReplacementRequest_active_workShiftId_key`, `ReplacementRequest_active_requester_location_date_key`, `ReplacementRequest_active_manual_location_date_key`) — ЗУПИНИТИСЬ і повідомити BLOCKED. Prisma не знає про ці індекси (вони створені сирим SQL), і спроба їх «вирівняти» знесла б захист від подвійного пошуку.

- [ ] **Step 4: Застосувати локально й перевірити клієнт**

Run: `npx prisma migrate dev`
Then: `npx tsc --noEmit`
Expected: типи чисті, `scheduledShiftPublicId` зʼявився в згенерованому клієнті.

- [ ] **Step 5: Коміт**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(replacements): поле scheduledShiftPublicId у заявці на підміну

Адитивна міграція: колонка nullable, наявні рядки лишаються як є. Часткові
унікальні індекси на workShiftId не чіпаються — вони захищають від двох
одночасних пошуків на одну зміну.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Писати обидва поля при створенні заявки (крок 2.1, код)

**Files:**
- Modify: `src/services/replacement-service.ts` (метод `startRequest`, ~рядки 308-360)
- Create: `src/services/__tests__/replacement-canonical-link.test.ts`

**Interfaces:**
- Consumes: поле зі схеми з Task 1.
- Produces: кожна нова заявка, створена через `startRequest`, несе обидва поля.

`createActiveRequest` (рядок 443) — єдина точка створення, вона приймає `Prisma.ReplacementRequestUncheckedCreateInput`, тож нове поле передається разом з рештою даних.

- [ ] **Step 1: Написати падаючий тест**

Створити `src/services/__tests__/replacement-canonical-link.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    workShift: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    replacementRequest: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    location: { count: vi.fn() },
    staffProfile: { findMany: vi.fn() },
    replacementResponse: { findMany: vi.fn() },
    $transaction: vi.fn(async (callback: any) => callback(prismaMock)),
};

vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService: {
        getAvailabilityForDate: vi.fn(),
        getAvailabilityForDateFromSchedule: vi.fn().mockResolvedValue(new Map()),
        getMonthlyScheduleSheetName: vi.fn().mockReturnValue("Вересень 2026"),
    },
}));
vi.mock("../../core/queue.js", () => ({ defaultQueue: { add: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const api: any = { sendMessage: vi.fn(), editMessageText: vi.fn() };

describe("startRequest — канонічний ідентифікатор зміни", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.replacementRequest.findFirst.mockResolvedValue(null);
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.replacementRequest.create.mockImplementation(async ({ data }: any) => ({
            id: "request-1",
            status: "ACTIVE",
            currentWave: null,
            nextWaveAt: null,
            ...data,
        }));
        prismaMock.location.count.mockResolvedValue(1);
        prismaMock.staffProfile.findMany.mockResolvedValue([]);
        prismaMock.replacementResponse.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
    });

    it("пише канонічний id зміни поряд із локальним", async () => {
        prismaMock.workShift.findUnique.mockResolvedValue({
            id: "shift-1",
            staffId: "staff-1",
            locationId: "loc-1",
            date: new Date("2030-05-10T00:00:00.000Z"),
            startTime: new Date("2030-05-10T08:00:00.000Z"),
            endTime: new Date("2030-05-10T17:00:00.000Z"),
            awsScheduledShiftPublicId: "11111111-1111-4111-8111-111111111111",
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "staff-1", fullName: "Тест", user: { telegramId: 123n } },
        });

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-1");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.workShiftId).toBe("shift-1");
        expect(created.scheduledShiftPublicId).toBe("11111111-1111-4111-8111-111111111111");
    });

    it("не падає, коли зміна ще не має канонічного id", async () => {
        prismaMock.workShift.findUnique.mockResolvedValue({
            id: "shift-2",
            staffId: "staff-1",
            locationId: "loc-1",
            date: new Date("2030-05-11T00:00:00.000Z"),
            startTime: new Date("2030-05-11T08:00:00.000Z"),
            endTime: new Date("2030-05-11T17:00:00.000Z"),
            awsScheduledShiftPublicId: null,
            location: { id: "loc-1", name: "Smile Park", city: "Київ", schedule: null },
            staff: { id: "staff-1", fullName: "Тест", user: { telegramId: 123n } },
        });

        const { replacementService } = await import("../replacement-service.js");
        await replacementService.startRequest(api, "staff-1", "shift-2");

        const created = prismaMock.replacementRequest.create.mock.calls[0]![0]!.data;
        expect(created.workShiftId).toBe("shift-2");
        expect(created.scheduledShiftPublicId).toBeNull();
    });
});
```

- [ ] **Step 2: Запустити тест і переконатись, що падає**

Run: `npx vitest run src/services/__tests__/replacement-canonical-link.test.ts`
Expected: FAIL — `expected undefined to be '11111111-...'`, бо поле ще не пишеться.

- [ ] **Step 3: Реалізувати**

У `startRequest`, у запиті `prisma.workShift.findUnique` (~рядок 309), додати `awsScheduledShiftPublicId` до вибірки, якщо його там немає: запит використовує `include: { location: true, staff: { include: { user: true } } }`, тобто повертає всі скалярні поля — окремо додавати нічого не треба, перевір і не змінюй без потреби.

Далі у виклик `this.createActiveRequest({ ... })` (~рядок 357) додати рядок поряд із `workShiftId: shift.id`:

```typescript
            scheduledShiftPublicId: shift.awsScheduledShiftPublicId,
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `npx vitest run src/services/__tests__/replacement-canonical-link.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Перевірити типи й повний прогін**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: типи чисті; прогін зелений, +2 тести до бази 1042/6866.

- [ ] **Step 6: Коміт**

```bash
git add src/services/replacement-service.ts src/services/__tests__/replacement-canonical-link.test.ts
git commit -m "feat(replacements): писати канонічний id зміни при створенні заявки

Подвійний запис: заявка несе і локальний workShiftId, і канонічний
scheduledShiftPublicId. Читання поки що зі старого поля — переклад читання
окремим кроком.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Бекфіл наявних заявок (крок 2.2, дані)

**Files:**
- Create: `scripts/backfill-replacement-scheduled-shift.ts`
- Create: `src/services/__tests__/replacement-canonical-backfill.test.ts`

**Interfaces:**
- Produces: `backfillReplacementScheduledShiftIds(db: BackfillDb): Promise<BackfillResult>`, де
  `BackfillResult = { scanned: number; filled: number; unmatched: number }`
  і `BackfillDb = { replacementRequest: { findMany: ..., update: ... }; workShift: { findMany: ... } }`

Чому окремий скрипт, а не міграція SQL: бекфіл читає `WorkShift.awsScheduledShiftPublicId` і має звітувати, скільки рядків лишилось без пари. SQL-міграція зробила б це мовчки, а мовчазна часткова міграція — саме те, чого цей проєкт уникає. Скрипт іде в `scripts/` поруч із наявними (`scripts/` уже містить міграційні утиліти).

- [ ] **Step 1: Написати падаючий тест**

Створити `src/services/__tests__/replacement-canonical-backfill.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { backfillReplacementScheduledShiftIds } from "../../../scripts/backfill-replacement-scheduled-shift.js";

describe("backfillReplacementScheduledShiftIds", () => {
    it("заповнює канонічний id там, де дзеркало знає пару", async () => {
        const update = vi.fn();
        const db = {
            replacementRequest: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "req-1", workShiftId: "shift-1" },
                    { id: "req-2", workShiftId: "shift-2" },
                ]),
                update,
            },
            workShift: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "shift-1", awsScheduledShiftPublicId: "canon-1" },
                    { id: "shift-2", awsScheduledShiftPublicId: "canon-2" },
                ]),
            },
        };

        const result = await backfillReplacementScheduledShiftIds(db as any);

        expect(result).toEqual({ scanned: 2, filled: 2, unmatched: 0 });
        expect(update).toHaveBeenCalledWith({
            where: { id: "req-1" },
            data: { scheduledShiftPublicId: "canon-1" },
        });
    });

    it("рахує заявки без пари, а не мовчить про них", async () => {
        const update = vi.fn();
        const db = {
            replacementRequest: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "req-1", workShiftId: "shift-1" },
                    { id: "req-2", workShiftId: "shift-missing" },
                ]),
                update,
            },
            workShift: {
                findMany: vi.fn().mockResolvedValue([
                    { id: "shift-1", awsScheduledShiftPublicId: "canon-1" },
                    { id: "shift-missing", awsScheduledShiftPublicId: null },
                ]),
            },
        };

        const result = await backfillReplacementScheduledShiftIds(db as any);

        expect(result).toEqual({ scanned: 2, filled: 1, unmatched: 1 });
        expect(update).toHaveBeenCalledTimes(1);
    });

    it("нічого не робить, коли заповнювати нема чого", async () => {
        const update = vi.fn();
        const db = {
            replacementRequest: { findMany: vi.fn().mockResolvedValue([]), update },
            workShift: { findMany: vi.fn() },
        };

        const result = await backfillReplacementScheduledShiftIds(db as any);

        expect(result).toEqual({ scanned: 0, filled: 0, unmatched: 0 });
        expect(update).not.toHaveBeenCalled();
        expect(db.workShift.findMany).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Запустити тест і переконатись, що падає**

Run: `npx vitest run src/services/__tests__/replacement-canonical-backfill.test.ts`
Expected: FAIL — модуль не знайдено.

- [ ] **Step 3: Реалізувати скрипт**

Створити `scripts/backfill-replacement-scheduled-shift.ts`:

```typescript
import prisma from "../src/db/core.js";

export type BackfillResult = {
    scanned: number;
    filled: number;
    unmatched: number;
};

type BackfillDb = {
    replacementRequest: {
        findMany: (args: unknown) => Promise<Array<{ id: string; workShiftId: string | null }>>;
        update: (args: unknown) => Promise<unknown>;
    };
    workShift: {
        findMany: (args: unknown) => Promise<Array<{ id: string; awsScheduledShiftPublicId: string | null }>>;
    };
};

/**
 * Заповнює `scheduledShiftPublicId` для заявок, створених до переходу.
 *
 * Пара береться з дзеркала: `WorkShift.awsScheduledShiftPublicId` — той самий
 * канонічний ідентифікатор, який синк проставляє кожному рядку.
 *
 * Заявки без пари не мовчать: вони рахуються в `unmatched`, і викликач має
 * показати це число. Мовчазний частковий бекфіл лишив би заявку прив'язаною
 * лише до локального рядка, і ніхто б про це не дізнався.
 */
export async function backfillReplacementScheduledShiftIds(db: BackfillDb): Promise<BackfillResult> {
    const requests = await db.replacementRequest.findMany({
        where: { scheduledShiftPublicId: null, workShiftId: { not: null } },
        select: { id: true, workShiftId: true },
    });

    if (requests.length === 0) return { scanned: 0, filled: 0, unmatched: 0 };

    const shiftIds = [...new Set(requests.flatMap(row => (row.workShiftId ? [row.workShiftId] : [])))];
    const shifts = await db.workShift.findMany({
        where: { id: { in: shiftIds } },
        select: { id: true, awsScheduledShiftPublicId: true },
    });
    const canonicalByShiftId = new Map(shifts.map(shift => [shift.id, shift.awsScheduledShiftPublicId]));

    let filled = 0;
    for (const request of requests) {
        const canonical = request.workShiftId ? canonicalByShiftId.get(request.workShiftId) : null;
        if (!canonical) continue;
        await db.replacementRequest.update({
            where: { id: request.id },
            data: { scheduledShiftPublicId: canonical },
        });
        filled += 1;
    }

    return { scanned: requests.length, filled, unmatched: requests.length - filled };
}

// Запуск напряму: `npx tsx scripts/backfill-replacement-scheduled-shift.ts`
if (process.argv[1]?.endsWith("backfill-replacement-scheduled-shift.ts")) {
    backfillReplacementScheduledShiftIds(prisma as unknown as BackfillDb)
        .then(result => {
            console.log(`scanned=${result.scanned} filled=${result.filled} unmatched=${result.unmatched}`);
            if (result.unmatched > 0) {
                console.warn(`УВАГА: ${result.unmatched} заявок лишились без канонічного id — перевір їх вручну.`);
            }
            return prisma.$disconnect();
        })
        .catch(async error => {
            console.error(error);
            await prisma.$disconnect();
            process.exit(1);
        });
}
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `npx vitest run src/services/__tests__/replacement-canonical-backfill.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Перевірити типи**

Run: `npx tsc --noEmit`
Expected: чисто

- [ ] **Step 6: Коміт**

```bash
git add scripts/backfill-replacement-scheduled-shift.ts src/services/__tests__/replacement-canonical-backfill.test.ts
git commit -m "feat(replacements): бекфіл канонічного id для наявних заявок

Скрипт, а не SQL-міграція: заявки без пари рахуються окремо й друкуються
попередженням. Мовчазний частковий бекфіл лишив би заявку прив'язаною лише
до локального рядка, і ніхто б не дізнався.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Донести канонічний id зміни до читача

**Files:**
- Modify: `src/services/aws-schedule-canonical-projector.ts` (тип `CanonicalScheduledShift` ~рядок 20, збирання обʼєкта ~рядок 80)
- Modify: `src/services/__tests__/aws-schedule-canonical-read.test.ts`

**Interfaces:**
- Produces: `CanonicalScheduledShift` додатково несе `scheduledShiftPublicId: string` — канонічний id тієї ж зміни.

**Навіщо ця задача.** Перевірено: `projectCanonicalSchedule` бере `shift.publicId` з відповіді бекенду, але в результат його НЕ кладе — лишається тільки локальний `projection.id`. Без канонічного id наступна задача не може зіставити зміну із заявкою за новим полем. Значення вже є в scope (`shift.publicId`), тож правка — один рядок у типі й один у збиранні.

**Чому це безпечно.** Тип споживають лише чотири файли (`replacement-selectable-shifts.ts`, `aws-schedule-canonical-projector.ts`, `aws-schedule-canonical-read.ts`, `replacement-service.ts`), і додавання поля нікого не ламає — це розширення, а не звуження. Дзеркальний фоллбек у `listSelectableShiftsFromMirror` теж має його заповнити: там значення береться з `row.awsScheduledShiftPublicId`, і воно nullable — тому в типі поле має бути `string | null`, а не `string`.

- [ ] **Step 1: Написати падаючий тест**

У `src/services/__tests__/aws-schedule-canonical-read.test.ts` додати до наявного тесту `"uses canonical business fields while preserving local technical identities"` перевірку, що результат несе канонічний id:

```typescript
        expect(projectCanonicalSchedule("staff-1", [canonicalShift], [location], [projection])[0])
            .toMatchObject({ scheduledShiftPublicId: canonicalShift.publicId });
```

- [ ] **Step 2: Запустити й переконатись, що падає**

Run: `npx vitest run src/services/__tests__/aws-schedule-canonical-read.test.ts`
Expected: FAIL — поля немає в результаті.

- [ ] **Step 3: Реалізувати**

У `src/services/aws-schedule-canonical-projector.ts` додати поле в тип `CanonicalScheduledShift`, одразу під `id`:

```typescript
    /** Канонічний id тієї ж зміни. `null` лише для рядків дзеркала, яких синк ще не звʼязав з каноном. */
    scheduledShiftPublicId: string | null;
```

І у збиранні обʼєкта (~рядок 80), одразу під `id: projection.id`:

```typescript
            scheduledShiftPublicId: shift.publicId,
```

У `src/services/replacement-service.ts`, у `listSelectableShiftsFromMirror`, додати те саме поле до обʼєктів, які будуються з рядків дзеркала:

```typescript
                scheduledShiftPublicId: row.awsScheduledShiftPublicId,
```

- [ ] **Step 4: Тести й типи**

Run: `npx vitest run src/services/__tests__/aws-schedule-canonical-read.test.ts src/services/__tests__/replacement-selectable-shifts.test.ts`
Run: `npx tsc --noEmit`
Expected: усе зелене. Якщо `tsc` свариться в інших місцях — значить якийсь споживач будує `CanonicalScheduledShift` вручну; додай поле й там, не кастуй.

- [ ] **Step 5: Коміт**

```bash
git add src/services/aws-schedule-canonical-projector.ts src/services/replacement-service.ts src/services/__tests__/aws-schedule-canonical-read.test.ts
git commit -m "feat(schedule): канонічний id зміни в проєкції розкладу

Проєктор брав shift.publicId, але в результат не клав — лишався тільки
локальний id. Без нього екран підміни не може зіставити зміну із заявкою за
канонічним полем.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Перемкнути читання на канонічне поле (крок 2.2, код)

**Files:**
- Modify: `src/services/replacement-service.ts` (`listSelectableShifts` ~рядок 190, `getSameReplacementSearchFilter` ~рядок 1105)
- Modify: `src/services/__tests__/replacement-canonical-link.test.ts`

**Interfaces:**
- Consumes: поле з Task 1, заповнене Task 2 (нові заявки) і Task 3 (наявні).
- Produces: читання, що віддає перевагу `scheduledShiftPublicId` і падає на `workShiftId` там, де канонічного немає.

**Що НЕ чіпати в цій задачі:**
- `reconcileRequestsChangedBySchedule` (~рядок 948) — він звіряє заявку з локальним дзеркалом за задумом, це його робота.
- Три часткові унікальні індекси — вони лишаються на `workShiftId`.
- Крок 2.3 — `workShiftId` нікуди не зникає.

- [ ] **Step 1: Написати падаючий тест**

Додати в `src/services/__tests__/replacement-canonical-link.test.ts` новий блок:

```typescript
describe("listSelectableShifts — блокування за канонічним id", () => {
    it("відкидає зміну, заявка на яку знайдена за канонічним id", async () => {
        prismaMock.replacementRequest.findMany.mockResolvedValue([
            { workShiftId: null, scheduledShiftPublicId: "canon-1" },
        ]);
        // решту моків узяти з наявного beforeEach цього файла
    });
});
```

Повний тест напиши сам за зразком наявних у `src/services/__tests__/replacement-selectable-shifts.test.ts`: канон повертає дві зміни, у заявки заповнене лише `scheduledShiftPublicId` (без `workShiftId`), і зміна з цим канонічним id має зникнути зі списку. Це доводить, що читання більше не залежить винятково від локального поля.

**Канонічний id уже доступний:** Task 4 додала `scheduledShiftPublicId` у `CanonicalScheduledShift`, і його заповнюють обидва джерела — канон із `shift.publicId`, дзеркало з `row.awsScheduledShiftPublicId`. Для зміни, якої синк ще не звʼязав з каноном, поле буде `null` — такий рядок зіставляється лише за `workShiftId`, як раніше. Не вигадуй синтетичних значень і не кастуй типи; якщо чогось бракує — поверни BLOCKED.

- [ ] **Step 2: Запустити тест і переконатись, що падає**

Run: `npx vitest run src/services/__tests__/replacement-canonical-link.test.ts`
Expected: FAIL — зміна лишається в списку, бо фільтр дивиться лише на `workShiftId`.

- [ ] **Step 3: Реалізувати**

У `listSelectableShifts` розширити запит блокувальних заявок так, щоб він відбирав і за локальним, і за канонічним полем, а множина блокувань будувалась з обох. Форма запиту:

```typescript
        const blocked = await prisma.replacementRequest.findMany({
            where: {
                requesterStaffId: staffId,
                status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES },
                OR: [
                    { workShiftId: { in: sortedShifts.map(shift => shift.id) } },
                    { scheduledShiftPublicId: { not: null } },
                ],
            },
            select: { workShiftId: true, scheduledShiftPublicId: true }
        });
```

У `getSameReplacementSearchFilter` (~рядок 1105) додати гілку за канонічним полем поряд із наявною за `workShiftId`:

```typescript
        if (request.scheduledShiftPublicId) {
            sameSearchFilters.push({ scheduledShiftPublicId: request.scheduledShiftPublicId });
        }
```

Допиши українські коментарі, які пояснюють, чому читання дивиться на обидва поля і коли старе перестане бути потрібним (крок 2.3, окремий PR).

- [ ] **Step 4: Запустити тести**

Run: `npx vitest run src/services/__tests__/replacement-canonical-link.test.ts src/services/__tests__/replacement-selectable-shifts.test.ts`
Expected: PASS — усі тести обох файлів.

- [ ] **Step 5: Типи й повний прогін**

Run: `npx tsc --noEmit`
Run: `npx vitest run`
Expected: чисто; прогін зелений.

- [ ] **Step 6: Коміт**

```bash
git add src/services/replacement-service.ts src/services/__tests__/replacement-canonical-link.test.ts
git commit -m "feat(replacements): читати блокування заявок за канонічним id

Читання віддає перевагу scheduledShiftPublicId і лишає workShiftId запасним
для заявок, створених до переходу. Зняття старого поля — окремий крок, коли
живих заявок на ньому не лишиться.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Покриття вимог зі спеки

| Вимога спеки (етап 2) | Де виконується |
|---|---|
| 2.1: додати `scheduledShiftPublicId String?` | Task 1 |
| 2.1: писати обидва поля | Task 2 |
| 2.2: бекфіл через `awsScheduledShiftPublicId` | Task 3 |
| 2.2: донести канонічний id до читача | Task 4 |
| 2.2: перемкнути читання, старе як запасне | Task 5 |
| Тест: створення пише обидва поля | Task 2, тест 1 |
| Тест: бекфіл заповнює наявні рядки | Task 3, тест 1 |
| Тест: рядок без пари лишається читабельним | Task 3, тест 2 + Task 5 (фоллбек на `workShiftId`) |
| 2.3: зняти `workShiftId` | **поза цим планом** — окремий PR після паузи |

## Чого цей план свідомо не робить

- **Не знімає `workShiftId`.** Крок 2.3 потребує, щоб закрились усі заявки, створені до переходу, — це дні календарного часу, а не роботи.
- **Не чіпає часткові унікальні індекси.** Вони лишаються на `workShiftId` до 2.3; перенесення унікальності на канонічне поле — частина того ж майбутнього PR.
- **Не чіпає `reconcileRequestsChangedBySchedule`.** Він звіряє заявку з дзеркалом за задумом.
