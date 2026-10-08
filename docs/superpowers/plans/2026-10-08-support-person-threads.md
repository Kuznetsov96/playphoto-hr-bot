# Support Person Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Замість тікетів і разових тем — одна постійна тема на співробітницю в чаті підтримки, з цитатами, правками, реакціями, статусом-іконкою і кнопками «покликати».

**Architecture:** Нові таблиці `SupportThread` + `SupportMessageLink`. Чисті функції форматування (`utils/support-thread-format.ts`), репозиторій, три сервіси без `ctx` (життєвий цикл теми, пересилання, ескалація) і один composer з обробниками. Стара логіка лишається під прапорцем `SUPPORT_THREADS_ENABLED=false`.

**Tech Stack:** TypeScript ESM, grammY 1.45 (Bot API 9.x: `reply_parameters`, `copyMessages`, `setMessageReaction`, `message_reaction`), Prisma 6.19 / PostgreSQL, Redis (ioredis), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-10-08-support-person-threads-design.md`

## Global Constraints

- Тексти команди — англійською в `src/constants/admin-texts.ts`; тексти фотографині — українською на «ти» в `src/constants/staff-texts.ts`, проходять `staff-texts-tone.test.ts` (одне емоційне емодзі, без 🌸, без ✨ у помилках).
- Назва теми: `Прізвище · Місто · Майданчик Філія`, ≤128 символів; ініціал (`surnameNameDot`) лише при збігу прізвищ.
- Іконки: лише 👀 ESCALATED і 📁 ARCHIVED з `getForumTopicIconStickers`; WAITING і ANSWERED — без іконки (кожна зміна іконки пише в тему службовий рядок; рішення власника 08.10).
- Реакція-підтвердження `✍`; текстове підтвердження лише після 6 год тиші і не на коротку подяку.
- Пауза між людьми при міграції 3 с; зв'язки живуть 90 днів.
- Прапорець проходить усі чотири ланки деплою: input форми → `release.env` → `deploy/aws/hooks/start.sh export` → `set_env` у `scripts/aws/deploy-production-bot.sh`, плюс контракт-скрипти.
- Схема і міграція комітяться разом; без `db push`.
- Перевірки: `npm run build`, `npm run check-cycles`, `npm run check-menu-ids`, `npm test`.

## Review Focus

1. Адмінка пише фотографині, у якої ще немає теми, двічі поспіль швидко — має бути одна тема (лок), обидва повідомлення в ній.
2. Менеджерка відповідає свайпом на повідомлення, якому понад 90 днів (зв'язок прибрано) — доставка без цитати, не помилка.
3. Фотографиня надсилає альбом із 3 фото з підписом — у темі один альбом, одне ✍, статус WAITING.
4. Адмін пише в тему LOGISTICS або General — бот не пересилає нікому і не пише «Not delivered».
5. Telegram відхиляє `quote` (текст правили) — повтор без цитати, повідомлення доходить.

---

### Task 1: Схема, міграція, прапорець

**Files:**
- Modify: `prisma/schema.prisma` (enum `SupportThreadStatus`, моделі `SupportThread`, `SupportMessageLink`, relation у `User`)
- Create: `prisma/migrations/20261008150000_support_threads/migration.sql`
- Modify: `src/config.ts` — `SUPPORT_THREADS_ENABLED: z.enum(["true","false"]).default("false")`, експорт `SUPPORT_THREADS_ENABLED` boolean
- Modify: `.github/workflows/deploy-aws-production.yml` (input `support_threads_enabled`, printf у release.env, рядок у звіті), `deploy/aws/hooks/start.sh` (export), `scripts/aws/deploy-production-bot.sh` (default, валідація, `set_env`), `scripts/aws/check-production-deploy-contract.mjs`, `scripts/aws/test-production-deploy-contract.mjs`
- Test: `src/__tests__/config-flags.test.ts` (наявний), `npm run check-production-deploy`

**Interfaces:**
- Produces: `SUPPORT_THREADS_ENABLED: boolean` з `src/config.ts`; Prisma-моделі `supportThread`, `supportMessageLink`.

- [ ] Додати в `config-flags.test.ts` кейс: без змінної `SUPPORT_THREADS_ENABLED === false`, з `"true"` — `true`. Запустити — FAIL.
- [ ] Додати схему (як у спеку) і SQL міграції вручну (CREATE TYPE, CREATE TABLE ×2, унікальні індекси `SupportThread_userId_key`, `SupportThread_chatId_topicId_key`, `SupportMessageLink_topicChatId_topicMessageId_key`, індекс `SupportMessageLink_privateChatId_privateMessageId_idx`, `SupportMessageLink_threadId_createdAt_idx`, FK `userId → User(id) ON DELETE CASCADE`, `threadId → SupportThread(id) ON DELETE CASCADE`). `npx prisma validate`, `npx prisma generate`.
- [ ] Прапорець у `config.ts` і в чотирьох ланках деплою за зразком `AWS_PARCELS_CANONICAL_READ_ENABLED`.
- [ ] `npx vitest run src/__tests__/config-flags.test.ts` і `npm run check-production-deploy` — PASS.
- [ ] Commit `feat(support): таблиці постійних тем і прапорець SUPPORT_THREADS_ENABLED`.

### Task 2: Чисті функції форматування

**Files:**
- Create: `src/utils/support-thread-format.ts`
- Test: `src/utils/__tests__/support-thread-format.test.ts`

**Interfaces:**
- Produces:
  - `kyivDay(at: Date): string` — `"2026-10-08"`.
  - `pickMainLocationId(shifts: {locationId: string}[], fallbackId: string | null): string | null` — найчастіша, нічия → та, що раніше в масиві.
  - `surnameOf(fullName: string): string`.
  - `threadNameLabel(staff: {fullName: string; surnameNameDot: string | null}, collidingSurnames: Set<string>): string`.
  - `formatThreadPlace(loc: {name: string; branch: string | null; city: string}): string` — `"Lviv · Dragon Park 2"`, `"Lviv · Smile Park Forum Lviv"`; кириличне місто → `normalizeCity`.
  - `buildThreadTitle(nameLabel: string, place: string | null): string` — `"Бланк · Lviv · Dragon Park 2"`, обрізання до 128.
  - `isAcknowledgement(message: {text?: string; caption?: string; sticker?: unknown; photo?: unknown; video?: unknown; document?: unknown; voice?: unknown; video_note?: unknown}): boolean`.
  - `type ThreadStatus = "WAITING" | "ANSWERED" | "ESCALATED" | "ARCHIVED"`.
  - `nextStatus(current: {status: ThreadStatus; escalatedToTelegramId: bigint | null}, event: {kind: "staff_question" | "staff_ack" | "support_reply" | "support_thumbs_up" | "bot_context" | "archived" | "escalated" | "back_to_support"; actorTelegramId?: bigint; targetTelegramId?: bigint; hasUnansweredQuestion?: boolean}): {status: ThreadStatus; escalatedToTelegramId: bigint | null}`.
  - `renderThreadCard(input: {today: {day: string; place: string | null; time: string | null} | null; archivedAt: string | null; fullName: string; username: string | null; phone: string | null; mainPlace: string | null}): string` (HTML, перший рядок — `📍 Today DD.MM: …`).

- [ ] Тести:

```ts
expect(buildThreadTitle("Бланк", "Lviv · Dragon Park 2")).toBe("Бланк · Lviv · Dragon Park 2");
expect(buildThreadTitle("Бланк", null)).toBe("Бланк");
expect(buildThreadTitle("Б".repeat(200), "Lviv · X").length).toBe(128);
expect(threadNameLabel({ fullName: "Іванова Анна Олександрівна", surnameNameDot: "Іванова А." }, new Set(["Іванова"]))).toBe("Іванова А.");
expect(threadNameLabel({ fullName: "Бланк Анастасія", surnameNameDot: "Бланк А." }, new Set())).toBe("Бланк");
expect(formatThreadPlace({ name: "Smile Park", branch: "Darynok", city: "Kyiv" })).toBe("Kyiv · Smile Park Darynok");
expect(formatThreadPlace({ name: "Leoland", branch: null, city: "Львів" })).toBe("Lviv · Leoland");
expect(pickMainLocationId([{ locationId: "a" }, { locationId: "b" }, { locationId: "b" }], "a")).toBe("b");
expect(pickMainLocationId([], "home")).toBe("home");
for (const t of ["Добре, дякую", "Гаразд", "Навзаєм 🤗", "дякую велике!", "ок", "+", "👍"]) expect(isAcknowledgement({ text: t })).toBe(true);
for (const t of ["Добре, а коли зміна?", "Дякую вам за розуміння, а гроші коли", "Можна завтра вийти"]) expect(isAcknowledgement({ text: t })).toBe(false);
expect(isAcknowledgement({ sticker: {} })).toBe(true);
expect(isAcknowledgement({ photo: [], caption: "дякую" })).toBe(false);
expect(nextStatus({ status: "ANSWERED", escalatedToTelegramId: null }, { kind: "staff_question" }).status).toBe("WAITING");
expect(nextStatus({ status: "WAITING", escalatedToTelegramId: null }, { kind: "staff_ack" }).status).toBe("WAITING");
expect(nextStatus({ status: "ESCALATED", escalatedToTelegramId: 1n }, { kind: "support_reply", actorTelegramId: 2n })).toEqual({ status: "ESCALATED", escalatedToTelegramId: 1n });
expect(nextStatus({ status: "ESCALATED", escalatedToTelegramId: 1n }, { kind: "support_reply", actorTelegramId: 1n })).toEqual({ status: "ANSWERED", escalatedToTelegramId: null });
expect(nextStatus({ status: "ESCALATED", escalatedToTelegramId: 1n }, { kind: "back_to_support", hasUnansweredQuestion: true })).toEqual({ status: "WAITING", escalatedToTelegramId: null });
expect(nextStatus({ status: "ARCHIVED", escalatedToTelegramId: null }, { kind: "staff_ack" }).status).toBe("ARCHIVED");
expect(renderThreadCard({ today: { day: "08.10", place: null, time: null }, archivedAt: null, fullName: "Бланк А", username: null, phone: null, mainPlace: null }).split("\n")[0]).toBe("📍 Today 08.10: no shift");
```

- [ ] FAIL → реалізація → PASS → commit `feat(support): назва, статус і картка постійної теми`.

### Task 3: Репозиторій тем і зв'язків

**Files:**
- Create: `src/repositories/support-thread-repository.ts`
- Modify: `src/core/container.ts` (реєстрація, як інші репозиторії)
- Test: `src/repositories/__tests__/support-thread-repository.test.ts` (мок `db/core.js`)

**Interfaces:**
- Produces `supportThreadRepository`:
  - `findByUserId(userId)`, `findByTopic(chatId: bigint, topicId: number)`, `findById(id)`
  - `create(data: {userId; chatId; topicId; title})`, `update(id, data: Partial<...>)`
  - `listActive(): Promise<Thread[]>` (не ARCHIVED), `listAll()`
  - `addLink(row: {threadId; direction: "IN"|"OUT"|"CONTEXT"; topicChatId: bigint; topicMessageId: number; privateChatId?: bigint; privateMessageId?: number; contextText?: string})` — `createMany` з `skipDuplicates`
  - `findLinkByTopicMessage(topicChatId: bigint, topicMessageId: number)`, `findLinkByPrivateMessage(privateChatId: bigint, privateMessageId: number)`
  - `listUnansweredIn(threadId, since: Date | null, limit: number)` — IN-зв'язки після `since`
  - `deleteLinksOlderThan(date)`
  - `findLegacyUserByTopic(topicId: number): Promise<string | null>` — тікет, вихідна, задача, без фільтра статусу
  - `listLegacyActive(): Promise<{userId: string; topics: number[]; ticketIds: number[]; outgoingIds: number[]; proofIds: string[]}[]>`
  - `closeLegacy(ids: {ticketIds; outgoingIds; proofIds})`
  - `listCollidingSurnames(): Promise<Set<string>>` — прізвища, що повторюються серед активних або тих, у кого є тема

- [ ] Тести на `addLink` з дублем (skipDuplicates), `findLegacyUserByTopic` порядок (тікет → вихідна → задача), `listCollidingSurnames`. FAIL → реалізація → PASS → commit.

### Task 4: Іконки та життєвий цикл теми

**Files:**
- Create: `src/services/support-thread-icons.ts`, `src/services/support-thread-service.ts`
- Modify: `src/constants/admin-texts.ts` (ключі `support-thread-*`)
- Test: `src/services/__tests__/support-thread-service.test.ts`

**Interfaces:**
- Consumes: Task 2, Task 3, `workShiftRepository`, `userRepository`, `withUserLock` з `supportConversationService`.
- Produces:
  - `resolveThreadIcons(api: Api): Promise<Record<ThreadStatus, string | null>>` (кеш у пам'яті процесу).
  - `supportThreadService.ensureThread(api: Api, userId: string): Promise<SupportThread>` — під локом; створює тему з назвою, картку, `pinChatMessage(disable_notification)`, іконку.
  - `supportThreadService.applyStatus(api, thread, event): Promise<SupportThread>` — `nextStatus` + `editForumTopic(icon)` лише при зміні.
  - `supportThreadService.refreshCard(api, thread, now = new Date()): Promise<void>` — `editMessageText`; «not modified» ігнор; картку видалено → нова + закріп.
  - `supportThreadService.refreshTitle(api, thread): Promise<void>`.
  - `supportThreadService.noticeIfAway(api, thread, now): Promise<void>` — рядок «Today at … (not the main point)» раз на день.
  - `supportThreadService.recreateTopic(api, thread): Promise<SupportThread>`.
  - `supportThreadService.archiveInactive(api)`, `supportThreadService.dailyRefresh(api)`.
  - `topicLink(chatId: bigint, topicId: number): string`.

- [ ] Тести з фейковим Api (`createForumTopic` → `{message_thread_id: 77}`, `sendMessage` → `{message_id}`), моком репозиторію:
  - дві паралельні `ensureThread` для одного користувача → `createForumTopic` викликано 1 раз;
  - назва `Бланк · Lviv · Dragon Park 2` з найчастішої точки змін;
  - `applyStatus` WAITING→WAITING не викликає `editForumTopic`;
  - `refreshCard` ігнорує «message is not modified»;
  - `noticeIfAway` двічі за день → один рядок.
- [ ] FAIL → реалізація → PASS → commit `feat(support): життєвий цикл постійної теми`.

### Task 5: Пересилання фотографиня → тема

**Files:**
- Create: `src/services/support-relay-service.ts`, `src/utils/album-buffer.ts`
- Modify: `src/constants/staff-texts.ts` (`support-thread-ack`, `support-thread-failed`, `support-thread-entry`, `support-thread-task-entry`)
- Test: `src/services/__tests__/support-relay-staff.test.ts`, `src/utils/__tests__/album-buffer.test.ts`

**Interfaces:**
- Produces:
  - `type ThreadContext = { topicHtml: string; contextText: string }`.
  - `supportRelayService.relayStaffMessage(api: Api, input: {userId: string; chatId: number; message: Message; contexts: ThreadContext[]}): Promise<"delivered" | "failed">`.
  - `supportRelayService.postBotContext(api, userId, ctx: ThreadContext, extra?: {items?: ...}): Promise<void>` — для звітів по задачах.
  - `AlbumBuffer<T>` з `add(key: string, item: T, flush: (items: T[]) => Promise<void>, delayMs = 1000)`.
- Поведінка: контекст → рядок «away» → `copyMessage`/`copyMessages` з `reply_parameters` (з `quote`, на помилку з `QUOTE` — без), зв'язок IN, статус, `setMessageReaction(✍)`, текст-підтвердження за правилом 6 год, тема видалена → `recreateTopic` і повтор.
- [ ] Тести:
  - перше повідомлення створює тему й пише текст-підтвердження; друге через хвилину — лише ✍;
  - «дякую» після 7 год тиші — лише ✍, статус не змінюється;
  - свайп на копію відповіді підтримки → `reply_parameters.message_id` = id в темі;
  - `copyMessage` кидає `Bad Request: QUOTE_TEXT_INVALID` → повтор без `quote`;
  - `copyMessage` кидає `message thread not found` → нова тема, повтор, рядок «Previous topic was deleted»;
  - альбом із 3 частин → один `copyMessages`, одна ✍, три IN-зв'язки;
  - друга невдача → фотографині `support-thread-failed`, результат `"failed"`.
- [ ] FAIL → реалізація → PASS → commit.

### Task 6: Пересилання тема → фотографиня, правки, реакції

**Files:**
- Modify: `src/services/support-relay-service.ts`, `src/handlers/admin/utils.ts` (`msgToHtml`: `expandable_blockquote` → `<blockquote expandable>`, `pre` з `language`, `text_mention` → `tg://user?id=`)
- Test: `src/services/__tests__/support-relay-support.test.ts`, `src/handlers/admin/__tests__/msg-to-html.test.ts`

**Interfaces:**
- Produces:
  - `supportRelayService.relaySupportMessage(api, input: {chatId: number; message: Message; sender: {id: number; firstName: string}}): Promise<"delivered" | "ignored" | "failed">` — тема людини або стара тема.
  - `supportRelayService.relayEdit(api, message: Message, side: "staff" | "support"): Promise<void>`.
  - `supportRelayService.relayReaction(api, update: MessageReactionUpdated, side: "staff" | "support"): Promise<void>`.
- [ ] Тести:
  - службове повідомлення (`forum_topic_edited`, `pinned_message`) → `"ignored"`;
  - тема без зв'язку з людиною (LOGISTICS) → `"ignored"`, нічого не надіслано;
  - анонімний адмін (`from.id === 1087968824`) → рядок `Not delivered: anonymous` у темі;
  - свайп на IN → `reply_parameters` на приватне повідомлення фотографині з `quote`;
  - свайп на CONTEXT → `sendMessage` з `<blockquote>` контексту перед текстом;
  - відповідь Кузнєцова при ESCALATED на Кузнєцова → ANSWERED; відповідь Support → лишається ESCALATED;
  - блок бота (403) → рядок `Not delivered: … blocked the bot`;
  - стара тема (тікет) → доставлено + рядок «now lives here» один раз;
  - правка тексту в темі → `editMessageText` у приватному чаті з `entities`;
  - 👍 підтримки на IN → `setMessageReaction` на оригінал і статус ANSWERED;
  - `msgToHtml` з `expandable_blockquote` і `pre` з мовою.
- [ ] FAIL → реалізація → PASS → commit.

### Task 7: Покликати і повернути

**Files:**
- Create: `src/services/support-escalation-service.ts`
- Modify: `src/constants/admin-texts.ts`
- Test: `src/services/__tests__/support-escalation-service.test.ts`

**Interfaces:**
- Produces: `supportEscalationService.call(api, threadId: string, target: "kuznetsov" | "hupalova", caller: {id: number; firstName: string})`, `supportEscalationService.backToSupport(api, threadId, actor: {id; firstName})`; callback-дані `sth:c:<threadId>:k|h`, `sth:b:<threadId>`.
- [ ] Тести: виклик ставить ESCALATED і `escalatedToTelegramId`, пише в тему згадку `tg://user?id=` з кнопкою `↩ Back to Support`, у приватні — копії до трьох IN без відповіді і кнопки; ціль без налаштованого id → помилка в спливашці, статус не змінюється; `backToSupport` з питанням без відповіді → WAITING. FAIL → реалізація → PASS → commit.

### Task 8: Підключення обробників і точок входу

**Files:**
- Create: `src/handlers/support-threads.ts` (composer: `sth:*` колбеки з перевіркою ролі, `edited_message`, `message_reaction`, групові повідомлення в темах SUPPORT)
- Modify: `src/handlers/index.ts` (composer перед `handleSupportGroupMessage` під прапорцем; неактивні співробітниці → `relayStaffMessage` замість «Account Inactive», колбек — український текст), `src/main.ts` (`allowed_updates` + `edited_message`, `message_reaction`), `src/modules/staff/index.ts` (під прапорцем: `handleStaffMessage` → релей; stray для співробітниць не потрібен), `src/modules/staff/handlers/support.ts` (`staff_help` під прапорцем → екран `support-thread-entry`), `src/modules/staff/handlers/menu.ts` (`startSupportFlow`, `staff_task_help`, `staff_task_proof_reply_`, `notifySupportAboutTaskProof` → `postBotContext`), `src/handlers/index.ts:637` і `src/handlers/commands.ts:159` (заперечення розсилки — контекст), `src/handlers/admin/search.ts` (`handleAdminMessageSend`, пряма відповідь) і `src/handlers/admin/index.ts` (AWAITING_REPLY) → `supportRelayService.sendFromAdminPanel` для співробітниць
- Test: `src/handlers/__tests__/support-threads-routing.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces: `supportRelayService.sendFromAdminPanel(api, input: {adminChatId: number; message: Message; admin: {id; firstName}; userId: string}): Promise<{topicUrl: string}>`.
- Контексти: `buildTaskContext(task)`, `buildShootContext(line)`, `buildBroadcastContext(id)`, `buildFinanceAuditContext(text)` в `support-relay-service.ts`.
- [ ] Тести маршрутизації: прапорець вимкнено → старий шлях; увімкнено → вільний текст співробітниці йде в `relayStaffMessage` з контекстом із сесії (`clarificationTaskId`, `shootSupportLine`, `broadcast_decline_reason`) і сесія чиститься; команда `/start` не пересилається; неактивна співробітниця → релей. FAIL → реалізація → PASS → commit.

### Task 9: Фонові задачі і перехід

**Files:**
- Create: `src/services/support-thread-migration.ts`
- Modify: `src/services/worker.ts` (під прапорцем: щоденно о 07:00 за Києвом `dailyRefresh` + `archiveInactive` + прибирання зв'язків старших 90 днів; одноразово через 60 с після старту — міграція з Redis-ключем; старі автозакриття тікетів/вихідних — лише коли прапорець вимкнено)
- Test: `src/services/__tests__/support-thread-migration.test.ts`

**Interfaces:**
- Produces: `migrateLegacyConversations(api, deps = {sleep}): Promise<{migrated: number}>`.
- [ ] Тести: ключ уже стоїть → нічого не робить; два старі тікети й задача однієї людини → одна нова тема, рядок «Previous conversation» з трьома посиланнями, у кожній старій «Moved», `closeForumTopic`, `closeLegacy`; збій на людині не зупиняє інших. FAIL → реалізація → PASS → commit.

### Task 10: Повна перевірка гілки

- [ ] `npm run build && npm run check-cycles && npm run check-menu-ids && npm test` (з мінімальним env з `bot-shadow-copy-in-outputs`).
- [ ] Ревʼю всієї гілки свіжим рецензентом; виправлення.
- [ ] PR у `main` бота.
