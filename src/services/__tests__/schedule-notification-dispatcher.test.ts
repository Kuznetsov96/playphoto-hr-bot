import { describe, expect, it } from "vitest";
import {
    buildDeliveryKeyboard,
    groupForDelivery,
    renderDeliveryGroup,
    toSafeFailureReason
} from "../schedule-notification-dispatcher.js";
import { shiftKey, type MonthContext } from "../schedule-month-context.js";
import type { AwsScheduleChangeKind } from "../aws-business-client.js";

describe("groupForDelivery", () => {
    it("combines one employee's batched changes into a single message", () => {
        const groups = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REMOVED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]!.notificationPublicIds).toEqual(["a", "b"]);
    });

    it("keeps urgent changes as their own message", () => {
        const groups = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_MOVED",
                urgency: "URGENT",
                batchId: null,
                payload: {},
            },
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        expect(groups).toHaveLength(2);
    });

    it("skips an employee with no linked Telegram account", () => {
        const groups = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: null,
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        expect(groups).toEqual([]);
    });

    it("does not batch two published batches of the same employee together", () => {
        const groups = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b2",
                payload: {},
            },
        ]);

        expect(groups.map(group => group.notificationPublicIds)).toEqual([["a"], ["b"]]);
    });

    it("keeps different employees in the same batch apart", () => {
        const groups = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
            {
                publicId: "b",
                employeePublicId: "e2",
                telegramId: "200",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        expect(groups).toHaveLength(2);
        expect(groups.map(group => group.telegramId)).toEqual(["100", "200"]);
    });

    it("never batches two urgent rows that share a batch id", () => {
        const groups = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_MOVED",
                urgency: "URGENT",
                batchId: "b1",
                payload: {},
            },
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_MOVED",
                urgency: "URGENT",
                batchId: "b1",
                payload: {},
            },
        ]);

        expect(groups).toHaveLength(2);
    });
});

const FALLBACK_LINE = "подробиці в «Мій графік»";

/** Mirrors the backend's ScheduleNotificationShiftSnapshot contract. */
function snapshot(overrides: Record<string, string> = {}) {
    return {
        startsAtLocal: "2026-08-10T10:00:00",
        endsAtLocal: "2026-08-10T18:00:00",
        timezone: "Europe/Kyiv",
        locationPublicId: "11111111-1111-4111-8111-111111111111",
        locationName: "Гулівер",
        locationCity: "Київ",
        ...overrides,
    };
}

describe("renderDeliveryGroup", () => {
    it("renders a SHIFT_MOVED as before and after with real location names and local times", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_MOVED",
                urgency: "URGENT",
                batchId: null,
                payload: {
                    before: snapshot(),
                    // Дату в кабінеті не змінити — лише час, точку й людину.
                    after: snapshot({
                        startsAtLocal: "2026-08-10T12:00:00",
                        endsAtLocal: "2026-08-10T20:00:00",
                        locationPublicId: "22222222-2222-4222-8222-222222222222",
                        locationName: "Ocean Plaza",
                        locationCity: "Київ",
                    }),
                    reason: "хвороба колеги",
                },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Гулівер");
        expect(text).toContain("Ocean Plaza");
        expect(text).toContain("10.08");
        expect(text).toContain("10:00");
        expect(text).toContain("18:00");
        expect(text).toContain("Нова точка і час: пн 10.08 · Гулівер (Kyiv), 10:00–18:00 → Ocean Plaza (Kyiv), 12:00–20:00");
        expect(text).not.toMatch(/Було|Стало/u);
        expect(text).toContain("20:00");
        // Причина власника — внутрішня помітка, фотографу не показується.
        expect(text).not.toContain("хвороба колеги");
        expect(text).not.toContain(FALLBACK_LINE);
    });

    it("never shows a location UUID to a photographer", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { after: snapshot() },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).not.toContain("11111111-1111-4111-8111-111111111111");
        expect(text).toContain("Гулівер");
    });

    it("renders SHIFT_ADDED with only an after snapshot and no empty 'was' line", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { after: snapshot() },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Гулівер");
        expect(text).not.toContain("Було:");
        expect(text).not.toContain(FALLBACK_LINE);
    });

    it("without the month at hand, lists added shifts as new ones — never as the whole month", () => {
        // Місяць прочитати не вдалося: «готовий» і «Змін: 4» читалися б як
        // увесь графік, а решти місяця бот не знає (інцидент 12.10.2026).
        const [group] = groupForDelivery(
            [
                ["2026-09-08T10:00:00", "Dragon Park 2"], // вт, навмисно не за порядком
                ["2026-09-01T10:00:00", "Dragon Park"], // вт
                ["2026-09-05T10:00:00", "Dragon Park"], // сб
                ["2026-09-06T10:00:00", "Dragon Park 2"], // нд
            ].map(([startsAtLocal, locationName], index) => ({
                publicId: `n${index}`,
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED" as const,
                urgency: "NORMAL" as const,
                batchId: "b1",
                payload: {
                    after: snapshot({
                        startsAtLocal: startsAtLocal!,
                        endsAtLocal: startsAtLocal!.replace("10:00", "20:00"),
                        locationName: locationName!,
                        locationCity: "Львів",
                    }),
                },
            }))
        );

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Нові зміни на вересень");
        expect(text).not.toContain("готовий");
        expect(text).not.toMatch(/Змін: |у вихідні/u);
        expect(text).toContain("Повний графік — у «Мій графік».");
        expect(text).not.toContain("Додано зміну");
        expect(text).not.toContain("Тепер:");
        // За датою, з локацією і часом; вихідні виділені.
        expect(text.indexOf("01.09")).toBeLessThan(text.indexOf("05.09"));
        expect(text).toContain("<b>сб 05.09</b> · Dragon Park (Lviv) · 10:00–20:00");
        expect(text).toContain("вт 08.09 · Dragon Park 2 (Lviv) · 10:00–20:00");
    });

    it("keeps a mixed batch as a change log, even when it contains added shifts", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { after: snapshot({ startsAtLocal: "2026-09-05T10:00:00" }) },
            },
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REMOVED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { before: snapshot({ startsAtLocal: "2026-09-06T10:00:00" }) },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Нова зміна");
        expect(text).toContain("Знято зміну");
        expect(text).not.toContain("Графік на");
    });

    it("keeps a single added shift as a change, not a published month", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { after: snapshot({ startsAtLocal: "2026-09-05T10:00:00" }) },
            },
        ]);

        expect(renderDeliveryGroup(group!)).toContain("Нова зміна");
    });

    it("writes one sentence per event with the weekday in the shift line", () => {
        // Людина не має рахувати, чи 12.09 — вихідний, і читати «Стало»
        // там, де нічого не було. Один рядок: подія + зміна.
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: null,
                payload: { after: snapshot({ startsAtLocal: "2026-09-12T10:00:00", endsAtLocal: "2026-09-12T20:00:00" }) },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Нова зміна: <b>сб 12.09</b> · Гулівер (Kyiv) · 10:00–20:00");
        expect(text).not.toContain("Стало:");
        // Дія живе в кнопці «Мій графік», текст її не дублює.
        expect(text).not.toContain("Загляни у");
    });

    it("names the person's role in a replacement instead of 'location or photographer changed'", () => {
        const taken = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "NORMAL",
                batchId: null,
                payload: { after: snapshot(), role: "accepted", offerPublicId: "o1" },
            },
        ])[0]!;
        const given = groupForDelivery([
            {
                publicId: "b",
                employeePublicId: "e2",
                telegramId: "200",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "NORMAL",
                batchId: null,
                payload: { before: snapshot(), role: "requester" },
            },
        ])[0]!;

        expect(renderDeliveryGroup(taken)).toContain("Зміну передано тобі: ");
        expect(renderDeliveryGroup(given)).toContain("Зміну передано колезі.");
        expect(renderDeliveryGroup(taken)).not.toContain("Змінено локацію або фотографа");
    });

    // Dragon Park 2, 30.09.2026: бекенд пише копію автора як SHIFT_REMOVED, і вона
    // отримала «🚨 Термінова зміна у графіку · ➖ Знято зміну» замість доброї новини.
    it("tells the requester her replacement was found, naming who took the shift", () => {
        const [group] = groupForDelivery([
            {
                publicId: "b",
                employeePublicId: "e2",
                telegramId: "200",
                changeKind: "SHIFT_REMOVED",
                urgency: "URGENT",
                batchId: null,
                payload: {
                    before: snapshot(),
                    role: "requester",
                    replacementPublicId: "r1",
                    counterpartDisplayName: "Анастасія <Бланк>",
                },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("✅ <b>Підміну знайдено</b>");
        expect(text).toContain("Зміну бере Анастасія &lt;Бланк&gt;.");
        expect(text).toContain("Цей день у тебе тепер вільний.");
        expect(text).not.toContain("Термінова");
        expect(text).not.toContain("Знято зміну");
    });

    // З 09.10.2026 вебапп шле підсумок підміни одразу (URGENT), щоб кнопка
    // скасування приходила, поки вікно відкрите. Прийняту зміну людина щойно
    // взяла сама — «🚨 Термінова зміна» тут злякала б, а не повідомила.
    it("does not call a replacement the photographer just took an urgent change", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "URGENT",
                batchId: null,
                payload: { after: snapshot(), role: "accepted", replacementPublicId: "r1" },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Графік оновлено");
        expect(text).not.toContain("Термінова");
        expect(text).toContain("Зміну передано тобі: ");
    });

    it("keeps an ordinary removal urgent when it is not a replacement", () => {
        const [group] = groupForDelivery([
            {
                publicId: "c",
                employeePublicId: "e2",
                telegramId: "200",
                changeKind: "SHIFT_REMOVED",
                urgency: "URGENT",
                batchId: null,
                payload: { before: snapshot() },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Терміново: графік оновлено");
        expect(text).toContain("\nЗнято зміну: ");
    });

    it("states an urgent change as a fact: no question and no answer buttons", () => {
        // Термінову зміну додали не просто так — це рішення власника.
        // Відповіді ніхто не читає, тому й не питаємо (рішення 29.08.2026).
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "URGENT",
                batchId: null,
                payload: { after: snapshot() },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Терміново: графік оновлено");
        expect(text).not.toContain("Підтверди");
        const buttons = buildDeliveryKeyboard(group!).inline_keyboard.flat();
        expect(buttons.map((button) => button.text)).toEqual(["🗓 Мій графік"]);
    });

    it("keeps a normal message free of any question", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: null,
                payload: { after: snapshot() },
            },
        ]);

        expect(renderDeliveryGroup(group!)).not.toContain("Підтверди");
    });

    it("renders SHIFT_REMOVED with only a before snapshot and no empty 'now' line", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REMOVED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { before: snapshot() },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Гулівер");
        expect(text).not.toContain("Стало:");
        expect(text).not.toContain(FALLBACK_LINE);
    });

    it("renders a replacement row's snapshot alongside its role", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "URGENT",
                batchId: null,
                payload: {
                    after: snapshot(),
                    role: "accepted",
                    replacementPublicId: "33333333-3333-4333-8333-333333333333",
                },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("Гулівер");
        expect(text).not.toContain(FALLBACK_LINE);
        expect(text).not.toContain("33333333-3333-4333-8333-333333333333");
    });

    it("escapes untrusted location text rather than emitting raw HTML", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { after: snapshot({ locationName: "<b>Ocean</b>" }) },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("&lt;b&gt;Ocean&lt;/b&gt;");
        expect(text).not.toContain("<b>Ocean</b>");
    });

    it("falls back only when the payload carries no usable snapshot", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        expect(renderDeliveryGroup(group!)).toContain(FALLBACK_LINE);
    });

    it("never prints the number of events as a total", () => {
        // «Всього змін: 19» під 14 знятими й 5 доданими читалося як 19 робочих
        // днів. Без місяця числа немає взагалі, лише куди дивитися.
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REMOVED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        const text = renderDeliveryGroup(group!);
        expect(text).not.toContain("Всього");
        expect(text).not.toMatch(/<b>2<\/b>/u);
        expect(text).toContain("Повний графік — у «Мій графік».");
    });
});

describe("buildDeliveryKeyboard", () => {
    it("gives urgent and normal messages the same single button — nobody reads acknowledgements", () => {
        const [urgent] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_MOVED",
                urgency: "URGENT",
                batchId: null,
                payload: {},
            },
        ]);
        const [normal] = groupForDelivery([
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: {},
            },
        ]);

        const urgentButtons = buildDeliveryKeyboard(urgent!).inline_keyboard.flat();
        expect(urgentButtons.map(button => button.text)).toEqual(["🗓 Мій графік"]);

        const normalButtons = buildDeliveryKeyboard(normal!).inline_keyboard.flat();
        expect(normalButtons.map(button => button.text)).toEqual(["🗓 Мій графік"]);
    });

    // Кнопка скасування переїхала на саму карточку оффера (replacement-callbacks.ts):
    // повідомлення графіка її більше не несе за жодних умов (09.10.2026).
    it("never puts an undo button on a schedule message", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "URGENT",
                batchId: null,
                payload: { role: "accepted", offerPublicId: "offer-1" },
            },
        ]);

        const buttons = buildDeliveryKeyboard(group!).inline_keyboard.flat();

        expect(buttons.map(button => button.text)).toEqual(["🗓 Мій графік"]);
    });
});

describe("toSafeFailureReason", () => {
    it("maps errors onto short codes without leaking the original message", () => {
        expect(toSafeFailureReason(new Error("Forbidden: bot was blocked by the user")))
            .toBe("TELEGRAM_RECIPIENT_UNREACHABLE");
        expect(toSafeFailureReason(new Error("Bad Request: chat not found")))
            .toBe("TELEGRAM_CHAT_NOT_FOUND");
        expect(toSafeFailureReason(new Error("Too Many Requests: retry after 30")))
            .toBe("TELEGRAM_RATE_LIMITED");
        expect(toSafeFailureReason(new Error("The operation was aborted"))).toBe("TELEGRAM_DELIVERY_TIMEOUT");
    });

    it("never echoes personal data from an unrecognised error", () => {
        const reason = toSafeFailureReason(new Error("failed for Олена Петренко +380671234567"));

        expect(reason).toBe("TELEGRAM_DELIVERY_FAILED");
        expect(reason).not.toMatch(/380|Петренко/u);
    });
});

const KARAMEL = "33333333-3333-4333-8333-333333333333";
const DRAGON = "44444444-4444-4444-8444-444444444444";

function sambirSnapshot(localDate: string, start = "14:00", end = "20:00", location = KARAMEL) {
    return {
        startsAtLocal: `${localDate}T${start}:00`,
        endsAtLocal: `${localDate}T${end}:00`,
        timezone: "Europe/Kyiv",
        locationPublicId: location,
        locationName: location === KARAMEL ? "Karamel" : "Dragon Park",
        locationBranch: location === KARAMEL ? "Atlant" : undefined,
        locationCity: location === KARAMEL ? "Sambir" : "Lviv",
    };
}

/** The person's month as the webapp reports it right now. */
function monthOf(month: string, shifts: Array<[string, string?, string?, string?]>): MonthContext {
    return new Map([[month, shifts.map(([localDate, start = "14:00", end = "20:00", location = KARAMEL]) => ({
        key: shiftKey(location, localDate, start),
        locationKey: location,
        shift: {
            localDate,
            locationLabel: location === KARAMEL ? "Karamel (Atlant) (Sambir)" : "Dragon Park (Lviv)",
            startsAtLocal: start,
            endsAtLocal: end,
        },
    }))]]);
}

function batch(rows: Array<{ kind: AwsScheduleChangeKind; before?: string; after?: string; role?: "accepted" | "requester" }>, urgency: "NORMAL" | "URGENT" = "NORMAL") {
    const [group] = groupForDelivery(rows.map((row, index) => ({
        publicId: `n${index}`,
        employeePublicId: "e1",
        telegramId: "100",
        changeKind: row.kind,
        urgency,
        batchId: urgency === "NORMAL" ? "b1" : null,
        payload: {
            ...(row.before ? { before: sambirSnapshot(row.before) } : {}),
            ...(row.after ? { after: sambirSnapshot(row.after) } : {}),
            ...(row.role ? { role: row.role } : {}),
        },
    })));
    return group!;
}

/** Visible text of one line, as Telegram shows it. */
const visible = (line: string) => line.replace(/<[^>]+>/gu, "").replace(/&amp;/gu, "&");

describe("renderDeliveryGroup with the person's month", () => {
    it("shows shifts written into a published month as a change of the whole month (incident 12.10.2026)", () => {
        // 07.10 вона отримала 12, 21, 26.10; 09.10 дописали 20 і 27.10.
        // Друге повідомлення мусить читатися як увесь жовтень, а не як ще один «готовий».
        const group = batch([
            { kind: "SHIFT_ADDED", after: "2026-10-20" },
            { kind: "SHIFT_ADDED", after: "2026-10-27" },
        ]);
        const months = monthOf("2026-10", [["2026-10-12"], ["2026-10-20"], ["2026-10-21"], ["2026-10-26"], ["2026-10-27"]]);

        const text = renderDeliveryGroup(group, months);

        expect(text).toContain("Графік на жовтень оновлено");
        expect(text).not.toContain("готовий");
        expect(text).toContain("Тепер у тебе <b>5</b> змін");
        expect(text).toContain("📍 Karamel (Atlant) (Sambir)");
        expect(text).toContain("\nвт 20.10 · 14:00–20:00 · нова");
        expect(text).toContain("\nвт 27.10 · 14:00–20:00 · нова");
        expect(text).toContain("\nпн 12.10 · 14:00–20:00");
        expect(text).not.toContain("➕");
        expect(text.indexOf("12.10")).toBeLessThan(text.indexOf("20.10"));
    });

    it("calls a month «готовий» only when the message carries all of it", () => {
        const group = batch([
            { kind: "SHIFT_ADDED", after: "2026-10-12" },
            { kind: "SHIFT_ADDED", after: "2026-10-18" },
            { kind: "SHIFT_ADDED", after: "2026-10-26" },
        ]);
        const months = monthOf("2026-10", [["2026-10-12"], ["2026-10-18"], ["2026-10-26"]]);

        const text = renderDeliveryGroup(group, months);

        expect(text).toContain("Графік на жовтень готовий");
        expect(text).toContain("У тебе <b>3</b> зміни · у вихідні: <b>1</b>");
        expect(text).not.toContain("нова");
        expect(text).toContain("<b>нд 18.10</b> · 14:00–20:00");
        expect(text).toContain("попроси підміну");
    });

    it("lists removed shifts above the month and counts only what is left", () => {
        // Тершак, 29.09: 14 знято, 5 додано — повідомлення сказало «Всього змін: 19».
        const group = batch([
            { kind: "SHIFT_REMOVED", before: "2026-10-03" },
            { kind: "SHIFT_REMOVED", before: "2026-10-04" },
            { kind: "SHIFT_ADDED", after: "2026-10-10" },
        ]);
        const months = monthOf("2026-10", [["2026-10-10"], ["2026-10-15"]]);

        const text = renderDeliveryGroup(group, months);

        expect(text).toContain("Графік на жовтень оновлено");
        expect(text).toContain("\nЗнято зміну: <b>сб 03.10</b> · 14:00–20:00");
        expect(text).toContain("\nЗнято зміну: <b>нд 04.10</b> · 14:00–20:00");
        expect(text).toContain("Тепер у тебе <b>2</b> зміни");
        expect(text).toContain("\n<b>сб 10.10</b> · 14:00–20:00 · нова");
        expect(text).not.toMatch(/<b>3<\/b>/u);
    });

    it("names a new date only for a change made around the owner's form, which cannot move a date", () => {
        const group = batch([{ kind: "SHIFT_MOVED", before: "2026-10-13", after: "2026-10-14" }]);
        const months = monthOf("2026-10", [["2026-10-14"], ["2026-10-20"]]);

        const text = renderDeliveryGroup(group, months);

        expect(text).toContain("Нова дата: вт 13.10 → ср 14.10 · 14:00–20:00");
        expect(text).toContain("\nср 14.10 · 14:00–20:00 · оновлена");
        expect(text).not.toMatch(/Було|Стало|🔄|➖|перенес/u);
    });

    it("names exactly what changed when the date stays: the time, or the venue", () => {
        const [timeGroup] = groupForDelivery([{
            publicId: "a", employeePublicId: "e1", telegramId: "100", changeKind: "SHIFT_MOVED", urgency: "NORMAL", batchId: "b1",
            payload: { before: sambirSnapshot("2026-10-14"), after: sambirSnapshot("2026-10-14", "12:00") },
        }]);
        const time = renderDeliveryGroup(timeGroup!, monthOf("2026-10", [["2026-10-14", "12:00"]]));
        expect(time).toContain("Новий час: ср 14.10 · 14:00–20:00 → 12:00–20:00");
        expect(time).toContain("\nср 14.10 · 12:00–20:00 · новий час");

        const [venueGroup] = groupForDelivery([{
            publicId: "a", employeePublicId: "e1", telegramId: "100", changeKind: "SHIFT_MOVED", urgency: "NORMAL", batchId: "b1",
            payload: { before: sambirSnapshot("2026-10-14", "10:00", "20:00", DRAGON), after: sambirSnapshot("2026-10-14", "10:00") },
        }]);
        const venue = renderDeliveryGroup(venueGroup!, monthOf("2026-10", [["2026-10-14", "10:00"]]));
        expect(venue).toContain("Нова точка: ср 14.10 · Dragon Park (Lviv) → Karamel (Atlant) (Sambir) · 10:00–20:00");
        // Точка тепер одна на весь місяць — вона в шапці, а рядок лишається коротким.
        expect(venue).toContain("📍 Karamel (Atlant) (Sambir)");
        expect(venue).toContain("\nср 14.10 · 10:00–20:00 · нова точка");
    });

    it("shows a shift the owner reassigned to her as new, without someone else's «Було»", () => {
        const group = batch([
            { kind: "SHIFT_REASSIGNED", before: "2026-10-14", after: "2026-10-14" },
            { kind: "SHIFT_ADDED", after: "2026-10-20" },
        ]);
        const months = monthOf("2026-10", [["2026-10-14"], ["2026-10-20"], ["2026-10-22"]]);

        const text = renderDeliveryGroup(group, months);

        expect(text).toContain("\nср 14.10 · 14:00–20:00 · нова");
        expect(text).not.toContain("Було");
    });

    it("names a shift given away through a replacement without a status emoji", () => {
        const group = batch([
            { kind: "SHIFT_REMOVED", before: "2026-10-14", role: "requester" },
            { kind: "SHIFT_ADDED", after: "2026-10-20" },
        ]);

        const text = renderDeliveryGroup(group, monthOf("2026-10", [["2026-10-20"]]));

        expect(text).toContain("\nПідміну знайдено: ср 14.10 · 14:00–20:00");
        expect(text).not.toMatch(/✅|➖/u);
    });

    it("says plainly when nothing is left in the month", () => {
        const group = batch([
            { kind: "SHIFT_REMOVED", before: "2026-10-14" },
            { kind: "SHIFT_REMOVED", before: "2026-10-20" },
        ]);

        const text = renderDeliveryGroup(group, monthOf("2026-10", []));

        expect(text).toContain("У жовтні змін у тебе більше немає.");
        expect(text).not.toContain("Тепер у тебе");
    });

    it("keeps the location in every line when the month spans two venues", () => {
        const group = batch([
            { kind: "SHIFT_ADDED", after: "2026-10-20" },
            { kind: "SHIFT_ADDED", after: "2026-10-21" },
        ]);
        const months = monthOf("2026-10", [["2026-10-12", "10:00", "20:00", DRAGON], ["2026-10-20"], ["2026-10-21"]]);

        const text = renderDeliveryGroup(group, months);

        expect(text).not.toContain("📍");
        expect(text).toContain("пн 12.10 · Dragon Park (Lviv) · 10:00–20:00");
        expect(text).toContain("вт 20.10 · Karamel (Atlant) (Sambir) · 14:00–20:00 · нова");
    });

    it("in a long changed month shows the marked lines and says how many are not shown", () => {
        const days = Array.from({ length: 20 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
        const group = batch([
            { kind: "SHIFT_ADDED", after: "2026-10-19" },
            { kind: "SHIFT_ADDED", after: "2026-10-20" },
        ]);

        const text = renderDeliveryGroup(group, monthOf("2026-10", days.map(day => [day] as [string])));

        expect(text).toContain("Тепер у тебе <b>20</b> змін");
        expect(text).toContain("пн 19.10 · 14:00–20:00 · нова");
        expect(text).toContain("вт 20.10 · 14:00–20:00 · нова");
        expect(text).not.toContain("01.10");
        expect(text).toContain("та ще 18 — у «Мій графік»");
    });

    it("gives every month its own section when the changes span two", () => {
        const group = batch([
            { kind: "SHIFT_ADDED", after: "2026-10-30" },
            { kind: "SHIFT_ADDED", after: "2026-11-02" },
        ]);
        const months: MonthContext = new Map([
            ...monthOf("2026-10", [["2026-10-12"], ["2026-10-30"]]),
            ...monthOf("2026-11", [["2026-11-02"]]),
        ]);

        const text = renderDeliveryGroup(group, months);

        expect(text).toContain("Графік на жовтень оновлено");
        expect(text).toContain("Графік на листопад готовий");
        expect(text.indexOf("жовтень")).toBeLessThan(text.indexOf("листопад"));
    });

    it("ends an urgent change with the month total instead of a list", () => {
        const group = batch([{ kind: "SHIFT_REMOVED", before: "2026-10-13" }], "URGENT");

        const text = renderDeliveryGroup(group, monthOf("2026-10", [["2026-10-20"], ["2026-10-21"], ["2026-10-26"], ["2026-10-27"]]));

        expect(text).toContain("Терміново: графік оновлено");
        expect(text).toContain("\nЗнято зміну:");
        expect(text).not.toMatch(/➖|➕|🔄|🔀/u);
        expect(text).toContain("Тепер у тебе в жовтні <b>4</b> зміни.");
        expect(text).not.toContain("➕");
    });

    it("keeps the date column straight: every list line starts with the weekday", () => {
        const group = batch([{ kind: "SHIFT_ADDED", after: "2026-10-20" }, { kind: "SHIFT_MOVED", before: "2026-10-22", after: "2026-10-23" }]);
        const text = renderDeliveryGroup(group, monthOf("2026-10", [["2026-10-12"], ["2026-10-20"], ["2026-10-23"]]));

        const list = text.split("\n").filter(line => /\d{2}\.\d{2} · \d{2}:\d{2}/u.test(line) && !line.includes(":"+" "));
        expect(list).toHaveLength(3);
        for (const line of list) expect(line).toMatch(/^(<b>)?(пн|вт|ср|чт|пт|сб|нд) /u);
    });

    it("fits a phone: every list line of a single-venue month stays short", () => {
        const group = batch([{ kind: "SHIFT_ADDED", after: "2026-10-20" }, { kind: "SHIFT_REMOVED", before: "2026-10-18" }]);
        const days = ["2026-10-04", "2026-10-11", "2026-10-12", "2026-10-20", "2026-10-25", "2026-10-31"];

        const text = renderDeliveryGroup(group, monthOf("2026-10", days.map(day => [day] as [string])));

        const lines = text.split("\n").filter(line => /\d{2}\.\d{2}/u.test(line));
        expect(lines.length).toBeGreaterThan(0);
        // На скрині 12.10 у рядок iPhone вміщалося «пн 12.10 · Karamel (Atlant) (Sambir) ·» — 38 знаків.
        for (const line of lines) expect(visible(line).length).toBeLessThanOrEqual(38);
        expect(text.split("\n").length).toBeLessThanOrEqual(20);
    });
});
