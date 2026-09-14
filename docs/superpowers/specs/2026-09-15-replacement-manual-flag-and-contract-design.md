# Явна ознака ручної заявки і зняття `workShiftId` — етап 2.3

**Date:** 2026-09-15
**Status:** Draft (design); implementation not started.

## Problem

Крок 2.3 задумувався як просте зняття `ReplacementRequest.workShiftId` після того, як заявки перейдуть на канонічний ідентифікатор. Перевірка проду показала, що так зробити не можна.

`workShiftId IS NULL` у цій схемі означає не «посилання відсутнє», а **«це ручна заявка адміністратора»** — заявка на локацію й день, створена через `startAdminRequest`, коли зміни в графіку взагалі немає. Ця ознака несе логіку у двох місцях:

1. Частковий унікальний індекс `ReplacementRequest_active_manual_location_date_key` — не дає завести дві активні ручні заявки на ту саму локацію й день.
2. Гілка `else` в `getSameReplacementSearchFilter` (`replacement-service.ts:1188`) — відрізняє ручну заявку від звичайної при пошуку «тієї самої заявки».

**Замінити ознаку на `scheduledShiftPublicId IS NULL` не можна.** У звичайної заявки на зміну, яку дзеркало ще не звʼязало з каноном, це поле теж `null` — і вона хибно зійшла б за ручну. Тоді індекс заблокував би законний запуск пошуку підміни.

Дані проду на 15.09.2026 підтверджують, що механізм живий, а не мертвий код:

| Категорія живих заявок (ACTIVE/FOUND) | Кількість |
|---|---|
| Ручні (без `workShiftId`) | 100 |
| Звичайні, з обома полями | 59 |
| **Звичайні зі старим полем, але без канону** | **0** |

Нуль в останньому рядку — умова, якої чекав крок 2.3: жодна жива заявка не тримається винятково на `workShiftId`.

## Goal

Зробити «ручна заявка» явною властивістю рядка, а не побічним наслідком порожнього посилання, і після цього зняти `workShiftId`.

**Hard constraint:** 159 живих заявок з відкритими оферами в Telegram не повинні осиротіти на жодному кроці. `DROP COLUMN` незворотний — revert поверне код, але не дані.

## Key Decisions

1. **Нова колонка `isManual Boolean @default(false)`**, а не `origin`-enum: питання бінарне, і два значення enum були б ускладненням без потреби. Якщо колись зʼявиться третє джерело заявок, enum можна ввести окремо.
2. **Бекфіл за наявною ознакою**: `isManual = true` там, де `workShiftId IS NULL`. Це рівно те, що ознака означає сьогодні, тож міграція даних однозначна.
3. **Expand/contract, як на кроці 2.1-2.2.** Спершу колонка й подвійна ознака, далі перемикання індексу й фільтра, і лише потім `DROP COLUMN`. Кожен крок лишає систему робочою.
4. **Індекс переносимо, а не прибираємо.** `ReplacementRequest_active_manual_location_date_key` — захист від двох ручних пошуків на ту саму локацію й день; його втрата означала б два паралельні пошуки на одну діру в графіку.
5. **`ReplacementRequest_active_workShiftId_key` переходить на `scheduledShiftPublicId`.** Він захищає від двох активних пошуків на одну зміну; після зняття локального поля роль ключа виконує канонічний ідентифікатор.
6. Коментарі українською (AGENTS.md).

## Architecture

### Крок A — expand: колонка й подвійний запис

```
ALTER TABLE "ReplacementRequest" ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ReplacementRequest" SET "isManual" = true WHERE "workShiftId" IS NULL;
```

`startAdminRequest` проставляє `isManual: true`, `startRequest` — `false` (дефолт). Читання поки що спирається на старі ознаки.

`UPDATE` у тій самій міграції, а не окремим скриптом: рядків небагато (за даними проду — сотні), а розрив між `ADD COLUMN` і бекфілом лишив би вікно, у якому ручна заявка виглядає звичайною.

### Крок B — перемикання читання та індексів

Індекси перевипускаються сирим SQL, як і оригінальні:

```
DROP INDEX "ReplacementRequest_active_manual_location_date_key";
CREATE UNIQUE INDEX "ReplacementRequest_active_manual_location_date_key"
ON "ReplacementRequest"("locationId", "shiftDate")
WHERE "status" = 'ACTIVE' AND "isManual" = true;

DROP INDEX "ReplacementRequest_active_workShiftId_key";
CREATE UNIQUE INDEX "ReplacementRequest_active_scheduled_shift_key"
ON "ReplacementRequest"("scheduledShiftPublicId")
WHERE "status" = 'ACTIVE' AND "scheduledShiftPublicId" IS NOT NULL;
```

`ReplacementRequest_active_requester_location_date_key` не чіпаємо — він спирається на `requesterStaffId`, а не на `workShiftId`.

У коді: гілка `else` в `getSameReplacementSearchFilter` переходить на `isManual: true`, `workShiftId`-гілки в читанні прибираються.

### Крок C — contract: зняти `workShiftId`

```
ALTER TABLE "ReplacementRequest" DROP COLUMN "workShiftId";
```

Разом із ним іде звʼязок `workShift @relation` зі схеми та останні згадки в коді.

**Передумова, яку треба перевірити безпосередньо перед кроком C:** нуль живих заявок, що тримаються лише на `workShiftId`. Запит наведено в розділі Testing.

## Error Handling

| Випадок | Поведінка |
|---|---|
| Ручна заявка створена до міграції | Бекфіл у кроці A проставить `isManual = true` за `workShiftId IS NULL` |
| Звичайна заявка без канонічного id | `isManual` лишається `false` — вона не сплутається з ручною; це і є та помилка, яку виправляє ця робота |
| Дві ручні заявки на локацію й день | Індекс на `isManual = true` кидає `P2002`, як і раніше |
| Два пошуки на одну зміну | Індекс на `scheduledShiftPublicId` кидає `P2002` |
| `awsScheduledShiftPublicId` ще не проставлений синком | Заявка створюється з `scheduledShiftPublicId: null`; унікальність по зміні в цей момент не діє. **Це ослаблення, не перенесення старого ризику без змін** — див. абзац нижче. |

Старий частковий індекс `ReplacementRequest_active_workShiftId_key` стояв на
`workShiftId WHERE workShiftId IS NOT NULL`, а `startRequest` завжди писав
`shift.id` — тобто індекс покривав 100% звичайних заявок. Новий
`ReplacementRequest_active_scheduled_shift_key` стоїть на
`scheduledShiftPublicId WHERE scheduledShiftPublicId IS NOT NULL`, а
`startRequest` пише `shift.awsScheduledShiftPublicId`, яке дорівнює `null`,
поки синк не зв'язав зміну з каноном. Така заявка випадає з предиката
нового індексу. Тобто захист на рівні БД від двох активних пошуків на одну
зміну **дійсно ослаб** — рівно для заявок, чию зміну дзеркало ще не встигло
зв'язати з каноном.

Що втрачено конкретно: гонка з двох майже одночасних натискань і випадок
двох різних співробітників, що шукають підміну на ту саму незв'язану
зміну, тепер тримаються лише кодом (перевірка в
`getSameReplacementSearchFilter` / гілці `scheduledShiftPublicId` у
`startRequest`), а не унікальним індексом БД.

Що лишається прикритим: гілка `requesterStaffId + locationId + shiftDate` у
`startRequest` працює безумовно (незалежно від того, зв'язана зміна з
каноном чи ні), і індекс `ReplacementRequest_active_requester_location_date_key`
її й далі захищає на рівні БД — цей індекс цим кроком не змінюється. На
проді станом на 15.09.2026 живих заявок без канонічного id — нуль, тобто
щілина зараз не реалізується жодним фактичним рядком, але існує структурно.

## Testing

Крок A:
- `startAdminRequest` створює заявку з `isManual: true`
- `startRequest` створює заявку з `isManual: false`
- міграція проставляє `isManual = true` рівно там, де `workShiftId IS NULL`

Крок B:
- ручна заявка знаходиться фільтром за `isManual`, а не за порожнім `workShiftId`
- звичайна заявка без канонічного id НЕ вважається ручною (ключовий тест цієї роботи)
- індекси: спроба другої активної ручної заявки на ту саму локацію й день падає; спроба другого пошуку на ту саму зміну падає

Крок C:
- жодна згадка `workShiftId` не лишилась у коді (`rg` в тесті або перевірка при ревʼю)

**Передумова кроку C — виконати на проді безпосередньо перед міграцією:**

```sql
SELECT count(*) FROM "ReplacementRequest"
WHERE status IN ('ACTIVE','FOUND') AND "workShiftId" IS NOT NULL AND "scheduledShiftPublicId" IS NULL;
```

Нуль — можна знімати колонку. Будь-яке інше число — чекати.

Регресія: повний прогін на кожному кроці (на 15.09.2026 база — 1044 файли / 6873 тести).

## Rollout

| PR | Зміст | Ризик | Зворотність |
|---|---|---|---|
| A | колонка `isManual` + бекфіл + подвійний запис | Низький | Повна (колонка адитивна) |
| B | перемикання індексів і читання | Середній | Повна (індекси перевипускаються назад) |
| C | `DROP COLUMN workShiftId` | Високий | **Незворотна** |

Між B і C — пауза й перевірка передумови на проді.

## Out of Scope

- `WorkShift` як таблиця лишається: її наповнює синк і читають інші місця.
- `ReplacementRequest_active_requester_location_date_key` не змінюється.
- Борг з обгорткою `scripts/backfill-replacement-scheduled-shift.ts` (імпортує з `src/`, якого немає в контейнері) — окрема дрібна правка, не частина цієї роботи.
- ~~**Можливе продовження, свідомо відкладене:** до-резолв канонічного id при створенні заявки.~~ **ЗРОБЛЕНО 15.09.2026.** `startRequest` більше не пише сире `shift.awsScheduledShiftPublicId`: канонічний шлях повертає вже розвʼязаний id (`startCanonicalReplacement`), а при вимкненому прапорці `startRequest` кличе `resolveCanonicalShift` сам. Заявка на зміну, якої синк ще не звʼязав з каноном, тепер потрапляє під унікальний індекс — щілину в захисті БД, описану в Error Handling вище, закрито. Якщо резолвер не знайшов id і запасним шляхом, поле лишається `null` і заявка живе на захисті рівня застосунку: помилку не кидаємо, бо людина не має втратити можливість попросити підміну через відставання синку.
