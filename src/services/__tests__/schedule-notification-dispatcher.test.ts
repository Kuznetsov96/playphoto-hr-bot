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
        expect(text).toContain("хвороба колеги");
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
