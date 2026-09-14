# Екран вибору підміни на канонічному джерелі — етап 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Екран «🔁 Шукати підміну» будує список зі свіжого канонічного джерела, а не з локального дзеркала, тож перестає розходитись з екраном «🗓 Мій графік».

**Architecture:** `listSelectableShifts` читає зміни через `awsScheduleCanonicalReadService.findForStaff` (той самий шлях, що вже обслуговує графік), відкидає зміни з активною заявкою локальним запитом і повертає той самий тип, що й раніше. При недоступності канону — фоллбек на дзеркало з warn-логом. Схема БД не змінюється.

**Tech Stack:** TypeScript, Prisma, grammY, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-replacement-picker-canonical-design.md`

## Global Constraints

- Тексти, які бачить фотографиня, — українською; адмінські — англійською (AGENTS.md).
- Без прапорця вмикання: перехід виїжджає одразу, відкат — revert PR (рішення користувача).
- Горизонт вибору — `SELECTABLE_HORIZON_DAYS = 62`, дорівнює `MAX_LIST_DAYS` бекенду.
- Таймаут користувацького читання — 3 с (`USER_VISIBLE_READ_TIMEOUT_MS` в `aws-schedule-canonical-read.ts`).
- Синтетичні id заборонені: вигаданий `shift.id` ламає дедуплікацію нагадувань у Redis.
- Кнопка та `startRequest` оперують локальним `WorkShift.id` — цей контракт етап 1 не змінює.
- Прогін усього набору (`npx vitest run`) має лишатись зеленим: 1041 файл / 6857 тестів на момент написання.

---

### Task 1: Канонічне читання списку з фоллбеком

**Files:**
- Create: `src/services/replacement-selectable-shifts.ts`
- Create: `src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`

**Interfaces:**
- Consumes: `awsScheduleCanonicalReadService.findForStaff(staffId: string, since: Date, limit: number): Promise<CanonicalScheduledShift[]>` з `src/services/aws-schedule-canonical-read.js`; `CanonicalScheduleReadError` звідти ж.
- Produces: `readSelectableShiftsSource(staffId: string, since: Date, horizonDays: number, deps: SelectableShiftsDeps): Promise<SelectableShiftsSource>`, де
  `SelectableShiftsSource = { shifts: CanonicalScheduledShift[]; source: "canonical" | "mirror" }`
  і `SelectableShiftsDeps = { canonical: (staffId: string, since: Date, limit: number) => Promise<CanonicalScheduledShift[]>; mirror: (staffId: string, since: Date, horizonDays: number) => Promise<CanonicalScheduledShift[]>; log: (entry: { reasonCode: string; errorType: string }) => void }`

Причина окремого файла: `replacement-service.ts` уже 1500+ рядків, і вкладати сюди ще й розгалуження джерел зробило б його ще важчим. Чиста функція з явними залежностями тестується без моків Prisma.

- [ ] **Step 1: Написати падаючий тест**

Створити `src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { readSelectableShiftsSource } from "../replacement-selectable-shifts.js";

const shift = (id: string, date: string) => ({
    id,
    staffId: "staff-1",
    locationId: "loc-1",
    date: new Date(`${date}T00:00:00.000Z`),
    startTime: new Date(`${date}T08:00:00.000Z`),
    endTime: new Date(`${date}T17:00:00.000Z`),
    location: { id: "loc-1", name: "Smile Park", city: "Київ", branch: null, schedule: null, openingHours: [] }
});

describe("readSelectableShiftsSource", () => {
    it("бере зміни з канону, коли той відповідає", async () => {
        const canonical = vi.fn().mockResolvedValue([shift("s-1", "2026-09-20")]);
        const mirror = vi.fn();
        const log = vi.fn();

        const result = await readSelectableShiftsSource("staff-1", new Date("2026-09-14"), 62, { canonical, mirror, log });

        expect(result.source).toBe("canonical");
        expect(result.shifts).toHaveLength(1);
        expect(mirror).not.toHaveBeenCalled();
        expect(canonical).toHaveBeenCalledWith("staff-1", new Date("2026-09-14"), 62);
    });

    it("падає на дзеркало і називає причину, коли канон недоступний", async () => {
        const canonical = vi.fn().mockRejectedValue(new Error("boom"));
        const mirror = vi.fn().mockResolvedValue([shift("s-2", "2026-09-21")]);
        const log = vi.fn();

        const result = await readSelectableShiftsSource("staff-1", new Date("2026-09-14"), 62, { canonical, mirror, log });

        expect(result.source).toBe("mirror");
        expect(result.shifts).toHaveLength(1);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "CANONICAL_SCHEDULE_UNAVAILABLE" }));
    });

    it("зберігає reasonCode канонічної помилки, коли він відомий", async () => {
        const { CanonicalScheduleReadError } = await import("../aws-schedule-canonical-projector.js");
        const canonical = vi.fn().mockRejectedValue(new CanonicalScheduleReadError("EMPLOYEE_NOT_MAPPED"));
        const mirror = vi.fn().mockResolvedValue([]);
        const log = vi.fn();

        await readSelectableShiftsSource("staff-1", new Date("2026-09-14"), 62, { canonical, mirror, log });

        expect(log).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "EMPLOYEE_NOT_MAPPED" }));
    });
});
```

- [ ] **Step 2: Запустити тест і переконатись, що падає**

Run: `npx vitest run src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`
Expected: FAIL — `Cannot find module '../replacement-selectable-shifts.js'`

- [ ] **Step 3: Написати мінімальну реалізацію**

Створити `src/services/replacement-selectable-shifts.ts`:

```typescript
import { CanonicalScheduleReadError, type CanonicalScheduledShift } from "./aws-schedule-canonical-projector.js";

export type SelectableShiftsSource = {
    shifts: CanonicalScheduledShift[];
    source: "canonical" | "mirror";
};

export type SelectableShiftsDeps = {
    canonical: (staffId: string, since: Date, limit: number) => Promise<CanonicalScheduledShift[]>;
    mirror: (staffId: string, since: Date, horizonDays: number) => Promise<CanonicalScheduledShift[]>;
    log: (entry: { reasonCode: string; errorType: string }) => void;
};

/**
 * Звідки взяти зміни для екрана вибору підміни.
 *
 * Канон — основне джерело: екран має показувати те саме, що «Мій графік»,
 * інакше свіжа зміна видима в одному місці й недоступна в іншому.
 *
 * Дзеркало лишається запасним шляхом, бо перед екраном стоїть людина: краще
 * показати дані п'ятихвилинної давнини, ніж помилку. Мовчки, бо для неї ці
 * дані валідні — розходження цікаве нам, і воно йде в лог.
 */
export async function readSelectableShiftsSource(
    staffId: string,
    since: Date,
    horizonDays: number,
    deps: SelectableShiftsDeps
): Promise<SelectableShiftsSource> {
    try {
        return { shifts: await deps.canonical(staffId, since, horizonDays), source: "canonical" };
    } catch (error) {
        deps.log({
            reasonCode: error instanceof CanonicalScheduleReadError
                ? error.reasonCode
                : "CANONICAL_SCHEDULE_UNAVAILABLE",
            errorType: error instanceof Error ? error.constructor.name : "UnknownError"
        });
        return { shifts: await deps.mirror(staffId, since, horizonDays), source: "mirror" };
    }
}
```

- [ ] **Step 4: Запустити тест і переконатись, що проходить**

Run: `npx vitest run src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Перевірити типи**

Run: `npx tsc --noEmit`
Expected: без помилок

- [ ] **Step 6: Коміт**

```bash
git add src/services/replacement-selectable-shifts.ts src/services/__tests__/replacement-selectable-shifts-canonical.test.ts
git commit -m "feat(replacements): джерело списку змін для підміни з фоллбеком

Канон як основне джерело, дзеркало як запасне. Чиста функція з явними
залежностями: розгалуження тестується без моків Prisma, а replacement-service
не росте ще на сотню рядків.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Фільтр активних заявок поверх канонічного списку

**Files:**
- Modify: `src/services/replacement-selectable-shifts.ts`
- Modify: `src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`

**Interfaces:**
- Consumes: `readSelectableShiftsSource` з Task 1.
- Produces: `rejectShiftsWithActiveRequest(shifts: CanonicalScheduledShift[], blockedShiftIds: Set<string>): CanonicalScheduledShift[]`

Чому фільтр лишається локальним: заявки на підміну живуть у локальній БД, канонічний бекенд про них не знає. Питання «чи є вже пошук по цій зміні» немає кому поставити, крім Prisma.

- [ ] **Step 1: Написати падаючий тест**

Додати в `src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`:

```typescript
import { rejectShiftsWithActiveRequest } from "../replacement-selectable-shifts.js";

describe("rejectShiftsWithActiveRequest", () => {
    it("прибирає зміни, для яких пошук уже триває", () => {
        const shifts = [shift("s-1", "2026-09-20"), shift("s-2", "2026-09-21")];

        const result = rejectShiftsWithActiveRequest(shifts, new Set(["s-1"]));

        expect(result.map(row => row.id)).toEqual(["s-2"]);
    });

    it("не чіпає список, коли активних заявок немає", () => {
        const shifts = [shift("s-1", "2026-09-20")];

        expect(rejectShiftsWithActiveRequest(shifts, new Set())).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Запустити тест і переконатись, що падає**

Run: `npx vitest run src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`
Expected: FAIL — `rejectShiftsWithActiveRequest is not a function`

- [ ] **Step 3: Написати мінімальну реалізацію**

Додати в `src/services/replacement-selectable-shifts.ts`:

```typescript
/**
 * Прибирає зміни, по яких пошук підміни вже триває.
 *
 * Фільтр локальний і таким лишається: заявки живуть у нашій БД, канонічний
 * бекенд їх не бачить.
 */
export function rejectShiftsWithActiveRequest(
    shifts: CanonicalScheduledShift[],
    blockedShiftIds: Set<string>
): CanonicalScheduledShift[] {
    return shifts.filter(shift => !blockedShiftIds.has(shift.id));
}
```

- [ ] **Step 4: Запустити тест і переконатись, що проходить**

Run: `npx vitest run src/services/__tests__/replacement-selectable-shifts-canonical.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Коміт**

```bash
git add src/services/replacement-selectable-shifts.ts src/services/__tests__/replacement-selectable-shifts-canonical.test.ts
git commit -m "feat(replacements): фільтр змін з активним пошуком підміни

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Перевести listSelectableShifts на нове джерело

**Files:**
- Modify: `src/services/replacement-service.ts:122-135` (метод `listSelectableShifts`)
- Modify: `src/services/__tests__/replacement-selectable-shifts.test.ts`

**Interfaces:**
- Consumes: `readSelectableShiftsSource`, `rejectShiftsWithActiveRequest` з Task 1–2; `awsScheduleCanonicalReadService.findForStaff`; `logBusinessEvent` з `src/core/log-events.js`.
- Produces: `listSelectableShifts(staffId: string)` — сигнатура та форма результату незмінні; кожен елемент і далі несе `id` (локальний `WorkShift.id`), `date`, `startTime`, `endTime`, `location`.

Контракт зберігається дослівно, бо на нього спираються `formatShiftButtonLabel`, `showReplacementConfirmation` і `startRequest`. Змінюється лише те, звідки взялися рядки.

**Про типи двох джерел.** Канон віддає `CanonicalScheduledShift`, дзеркало — рядок Prisma з `include: { location: true }`. Вони сумісні структурно: `openingHours` у `LocalScheduleLocation` опціональне, а решта полів (`id`, `name`, `city`, `branch`, `schedule`) є в моделі `Location`. Якщо `tsc` усе ж поскаржиться на звуження типу у фоллбеку, привести результат дзеркала до `CanonicalScheduledShift[]` явним `map`, а не `as`-кастом: каст сховав би справжню розбіжність, якби вона з'явилась.

- [ ] **Step 1: Написати падаючий тест**

Замінити вміст `src/services/__tests__/replacement-selectable-shifts.test.ts` (наявний тест горизонту переїжджає сюди ж, бо запит до дзеркала тепер у фоллбеку):

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
    workShift: { findMany: vi.fn() },
    replacementRequest: { findMany: vi.fn() }
};

const canonicalRead = { findForStaff: vi.fn() };

vi.mock("../../db/core.js", () => ({ default: prismaMock }));
vi.mock("../aws-schedule-canonical-read.js", async () => {
    const actual = await vi.importActual<typeof import("../aws-schedule-canonical-projector.js")>(
        "../aws-schedule-canonical-projector.js"
    );
    return {
        awsScheduleCanonicalReadService: canonicalRead,
        CanonicalScheduleReadError: actual.CanonicalScheduleReadError
    };
});
vi.mock("../schedule-availability-service.js", () => ({
    scheduleAvailabilityService: {
        getAvailabilityForDate: vi.fn(),
        getAvailabilityForDateFromSchedule: vi.fn(),
        getMonthlyScheduleSheetName: vi.fn()
    }
}));
vi.mock("../../core/queue.js", () => ({ defaultQueue: { add: vi.fn() } }));
vi.mock("../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const canonicalShift = (id: string, date: string) => ({
    id,
    staffId: "staff-1",
    locationId: "loc-1",
    date: new Date(`${date}T00:00:00.000Z`),
    startTime: new Date(`${date}T08:00:00.000Z`),
    endTime: new Date(`${date}T17:00:00.000Z`),
    location: { id: "loc-1", name: "Smile Park", city: "Київ", branch: null, schedule: null, openingHours: [] }
});

describe("listSelectableShifts", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.replacementRequest.findMany.mockResolvedValue([]);
        prismaMock.workShift.findMany.mockResolvedValue([]);
    });

    it("будує список з канону, а не з дзеркала", async () => {
        canonicalRead.findForStaff.mockResolvedValue([
            canonicalShift("s-1", "2026-09-20"),
            canonicalShift("s-2", "2026-09-21")
        ]);
        const { replacementService } = await import("../replacement-service.js");

        const result = await replacementService.listSelectableShifts("staff-1");

        expect(result.map(row => row.id)).toEqual(["s-1", "s-2"]);
        expect(prismaMock.workShift.findMany).not.toHaveBeenCalled();
    });

    it("прибирає зміну, по якій пошук уже триває", async () => {
        canonicalRead.findForStaff.mockResolvedValue([
            canonicalShift("s-1", "2026-09-20"),
            canonicalShift("s-2", "2026-09-21")
        ]);
        prismaMock.replacementRequest.findMany.mockResolvedValue([{ workShiftId: "s-1" }]);
        const { replacementService } = await import("../replacement-service.js");

        const result = await replacementService.listSelectableShifts("staff-1");

        expect(result.map(row => row.id)).toEqual(["s-2"]);
    });

    it("падає на дзеркало з горизонтом у 62 дні, коли канон недоступний", async () => {
        canonicalRead.findForStaff.mockRejectedValue(new Error("boom"));
        const { replacementService } = await import("../replacement-service.js");

        await replacementService.listSelectableShifts("staff-1");

        const query = prismaMock.workShift.findMany.mock.calls[0]![0]! as any;
        expect(query.take).toBeUndefined();
        const spanDays = Math.round(
            (query.where.date.lte.getTime() - query.where.date.gte.getTime()) / 86_400_000
        );
        expect(spanDays).toBe(61);
    });
});
```

- [ ] **Step 2: Запустити тест і переконатись, що падає**

Run: `npx vitest run src/services/__tests__/replacement-selectable-shifts.test.ts`
Expected: FAIL — перший тест падає на `expect(prismaMock.workShift.findMany).not.toHaveBeenCalled()`, бо метод досі читає дзеркало

- [ ] **Step 3: Написати реалізацію**

У `src/services/replacement-service.ts` замінити тіло `listSelectableShifts` (докблок зберегти, дописавши абзац про джерело):

```typescript
    async listSelectableShifts(staffId: string) {
        const today = this.kyivStartOfDay(new Date());
        const { shifts } = await readSelectableShiftsSource(staffId, today, SELECTABLE_HORIZON_DAYS, {
            canonical: (id, since, horizon) =>
                awsScheduleCanonicalReadService.findForStaff(id, since, horizon),
            mirror: (id, since, horizon) => this.listSelectableShiftsFromMirror(id, since, horizon),
            log: entry => logBusinessEvent({
                event: "bot.replacement_picker_canonical_read.fallback",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "fallback",
                reasonCode: entry.reasonCode,
                module: "replacement-selectable-shifts",
                operation: "read",
                safeContext: { errorType: entry.errorType }
            })
        });

        const blocked = await prisma.replacementRequest.findMany({
            where: {
                requesterStaffId: staffId,
                status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES },
                workShiftId: { in: shifts.map(shift => shift.id) }
            },
            select: { workShiftId: true }
        });

        return rejectShiftsWithActiveRequest(
            shifts,
            new Set(blocked.flatMap(row => (row.workShiftId ? [row.workShiftId] : [])))
        );
    }

    /**
     * Запасний шлях: той самий запит, яким екран жив до переходу на канон.
     * Лишається рівно для випадку, коли канон недоступний — дані можуть бути
     * на кілька хвилин старіші, але екран не падає.
     */
    private async listSelectableShiftsFromMirror(staffId: string, since: Date, horizonDays: number) {
        const horizon = new Date(since.getTime() + (horizonDays - 1) * DAY_MS);
        return prisma.workShift.findMany({
            where: {
                staffId,
                date: { gte: since, lte: horizon },
                replacementRequests: {
                    none: { status: { in: REPLACEMENT_RESTART_BLOCKING_STATUSES } }
                }
            },
            include: { location: true },
            orderBy: { date: "asc" }
        });
    }
```

Додати імпорти на початку файла:

```typescript
import { awsScheduleCanonicalReadService } from "./aws-schedule-canonical-read.js";
import { logBusinessEvent } from "../core/log-events.js";
import {
    readSelectableShiftsSource,
    rejectShiftsWithActiveRequest
} from "./replacement-selectable-shifts.js";
```

(`logBusinessEvent` може вже бути імпортований — тоді рядок не дублювати.)

- [ ] **Step 4: Запустити тест і переконатись, що проходить**

Run: `npx vitest run src/services/__tests__/replacement-selectable-shifts.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Перевірити типи**

Run: `npx tsc --noEmit`
Expected: без помилок

- [ ] **Step 6: Прогнати весь набір**

Run: `npx vitest run`
Expected: PASS — усі файли; порівняти з базою 1041 файл / 6857 тестів

- [ ] **Step 7: Коміт**

```bash
git add src/services/replacement-service.ts src/services/__tests__/replacement-selectable-shifts.test.ts
git commit -m "feat(replacements): екран вибору підміни читає канон

Екран жив на локальному дзеркалі, тоді як «Мій графік» читає канон, тож у
вікні синку вони розходились: свіжа зміна вже в графіку, але ще недоступна
для пошуку підміни. На проді це 31 пропуск за три доби, з них шість разів
не показалось жодної зміни.

Джерело тепер спільне. Дзеркало лишається запасним шляхом: перед екраном
стоїть людина, і дані п'ятихвилинної давнини кращі за помилку.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Оновити документ про читачів дзеркала

**Files:**
- Modify: `docs/canonical-schedule-remaining-readers.md`

Без цього наступний читач побачить, що `replacement-service.ts:103` віднесено до «не переводити», а код робить протилежне, і вважатиме це недоглядом.

- [ ] **Step 1: Виправити рядок групи B**

У таблиці групи B прибрати рядок `replacement-service.ts:103` і додати під таблицею абзац:

```markdown
**Оновлено 14.09.2026.** `listSelectableShifts` (екран вибору зміни для
підміни) переведено на канонічне читання — див.
`docs/superpowers/specs/2026-09-14-replacement-picker-canonical-design.md`.

Аргумент цього документа лишається чинним для решти групи: у фонових
читачів мережевий збій перетворюється на втрачену дію, а свіжість у п'ять
хвилин нічого не змінює. Для екрана, перед яким чекає людина, баланс
інший — там розходження з «Моїм графіком» видно неозброєним оком, а
фоллбек на дзеркало зберігає стійкість до збою.
```

- [ ] **Step 2: Коміт**

```bash
git add docs/canonical-schedule-remaining-readers.md
git commit -m "docs(schedule): екран підміни більше не читач дзеркала

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Покриття тестів зі спеки

| Вимога спеки | Де перевіряється |
|---|---|
| список будується з канону, а не з дзеркала | Task 3, тест 1 |
| зміна з активною заявкою відфільтрована | Task 2 + Task 3, тест 2 |
| канон недоступний → фоллбек, лог із `reasonCode` | Task 1, тести 2–3 |
| горизонт 62 дні зберігається | Task 3, тест 3 |
| зміна без дзеркала пропускається, решта показується | **уже покрито**: `src/services/__tests__/aws-schedule-canonical-read.test.ts:59` — не дублювати |

## Що лишається на етап 2

Цей план не чіпає `ReplacementRequest.workShiftId`. Доки зв'язок спирається на
локальний рядок, зміна, якої ще немає в дзеркалі, не дасть локального `id` і
пропускається проєктором — той самий `shift_not_mirrored`, що й у графіку.
Етап 1 прибирає розходження між двома екранами; повне зняття залежності — це
PR 2–4 зі спеки (expand → backfill → contract), і вони планують окремо.
