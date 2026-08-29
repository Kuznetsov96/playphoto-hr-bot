import { describe, expect, it } from "vitest";
import {
    buildDeliveryKeyboard,
    groupForDelivery,
    renderDeliveryGroup,
    toSafeFailureReason
} from "../schedule-notification-dispatcher.js";

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

const FALLBACK_LINE = "деталі уточнюються";

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
                    after: snapshot({
                        startsAtLocal: "2026-08-11T12:00:00",
                        endsAtLocal: "2026-08-11T20:00:00",
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
        expect(text).toContain("11.08");
        expect(text).toContain("12:00");
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

    it("renders a published month as a calendar with a summary, not as a change log", () => {
        // Публікація — пакет із самих «додано». Людині потрібен календар і
        // підсумок по всіх локаціях (вихідні — найкасовіші, їх порівнюють),
        // а не одинадцять однакових заголовків «➕ Додано зміну».
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

        expect(text).toContain("Графік на вересень готовий");
        expect(text).toContain("Змін: <b>4</b> · у вихідні: <b>2</b>");
        expect(text).not.toContain("Додано зміну");
        expect(text).not.toContain("Тепер:");
        // За датою, з локацією і часом; вихідні виділені.
        expect(text.indexOf("01.09")).toBeLessThan(text.indexOf("05.09"));
        expect(text).toContain("<b>сб 05.09</b> · Dragon Park (Lviv) · 10:00–20:00");
        expect(text).toContain("вт 08.09 · Dragon Park 2 (Lviv) · 10:00–20:00");
        expect(text).toContain("попроси підміну");
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

        expect(text).toContain("➕ Нова зміна: <b>сб 12.09</b> · Гулівер (Kyiv) · 10:00–20:00");
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
        expect(renderDeliveryGroup(given)).toContain("Твою зміну передано іншому фотографу: ");
        expect(renderDeliveryGroup(taken)).not.toContain("Змінено локацію або фотографа");
    });

    it("asks an urgent question in words, matching the buttons underneath", () => {
        const added = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_ADDED",
                urgency: "URGENT",
                batchId: null,
                payload: { after: snapshot() },
            },
        ])[0]!;
        const removed = groupForDelivery([
            {
                publicId: "b",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REMOVED",
                urgency: "URGENT",
                batchId: null,
                payload: { before: snapshot() },
            },
        ])[0]!;

        expect(renderDeliveryGroup(added)).toContain("Підтверди, будь ласка, чи вийдеш.");
        expect(renderDeliveryGroup(removed)).toContain("Підтверди, будь ласка, що бачиш це.");
        // «Не зможу» на зняту зміну — не зможу що? Лишається одна кнопка.
        const removedButtons = buildDeliveryKeyboard(removed).inline_keyboard.flat();
        expect(removedButtons.map((button) => button.text)).toEqual(["✅ Бачу"]);
        expect((removedButtons[0] as { callback_data: string }).callback_data).toMatch(/^cb:snack:b:/u);
    });

    it("never shows the owner's cancellation reason to the photographer", () => {
        // Поле «Reason» у діалозі скасування — внутрішня помітка власника.
        // Старі рядки ще можуть нести його в payload.
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REMOVED",
                urgency: "NORMAL",
                batchId: null,
                payload: { before: snapshot(), reason: "не дуже старалась" },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).not.toContain("не дуже старалась");
        expect(text).not.toContain("Причина");
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

    it("summarises the count for a batched message", () => {
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

        expect(renderDeliveryGroup(group!)).toContain("Всього змін: <b>2</b>");
    });
});

describe("buildDeliveryKeyboard", () => {
    it("offers acknowledgement buttons only for an urgent message", () => {
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
        expect(urgentButtons.map(button => button.text)).toEqual(["✅ Підтверджую", "🚫 Не зможу"]);

        const normalButtons = buildDeliveryKeyboard(normal!).inline_keyboard.flat();
        expect(normalButtons.map(button => button.text)).toEqual(["🗓 Мій графік"]);
    });

    // Critical 2: the accepting photographer's own undo button. Attached only
    // to the one message that is unambiguously "you just accepted this,
    // moments ago" — a lone SHIFT_REASSIGNED notification addressed to her,
    // carrying the offer id the undo endpoint needs.
    it("adds an undo button to a lone SHIFT_REASSIGNED reassignment addressed to the accepting candidate", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "NORMAL",
                batchId: null,
                payload: { role: "accepted", offerPublicId: "offer-1" },
            },
        ]);

        const buttons = buildDeliveryKeyboard(group!).inline_keyboard.flat();

        expect(buttons.map(button => button.text)).toContain("↩️ Це помилка, скасувати");
        const undoButton = buttons.find(button => button.text === "↩️ Це помилка, скасувати");
        expect((undoButton as { callback_data: string }).callback_data).toMatch(/^cb:replun:offer-1:/u);
    });

    it("does not offer undo on the requester's own copy of the reassignment (role: requester)", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e2",
                telegramId: "200",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "NORMAL",
                batchId: null,
                payload: { role: "requester" },
            },
        ]);

        const buttons = buildDeliveryKeyboard(group!).inline_keyboard.flat();

        expect(buttons.map(button => button.text)).not.toContain("↩️ Це помилка, скасувати");
    });

    it("does not offer undo once the reassignment is batched with other changes — a tap must never risk undoing the wrong shift", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "NORMAL",
                batchId: "b1",
                payload: { role: "accepted", offerPublicId: "offer-1" },
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

        const buttons = buildDeliveryKeyboard(group!).inline_keyboard.flat();

        expect(buttons.map(button => button.text)).not.toContain("↩️ Це помилка, скасувати");
    });

    it("does not offer undo when the payload is missing offerPublicId", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_REASSIGNED",
                urgency: "NORMAL",
                batchId: null,
                payload: { role: "accepted" },
            },
        ]);

        const buttons = buildDeliveryKeyboard(group!).inline_keyboard.flat();

        expect(buttons.map(button => button.text)).not.toContain("↩️ Це помилка, скасувати");
    });

    it("still offers undo on an urgent reassignment, alongside the acknowledgement buttons", () => {
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

        expect(buttons.map(button => button.text)).toEqual([
            "✅ Підтверджую",
            "🚫 Не зможу",
            "↩️ Це помилка, скасувати",
        ]);
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
