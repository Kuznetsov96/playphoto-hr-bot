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

describe("renderDeliveryGroup", () => {
    it("renders the before/after snapshot and escapes untrusted payload text", () => {
        const [group] = groupForDelivery([
            {
                publicId: "a",
                employeePublicId: "e1",
                telegramId: "100",
                changeKind: "SHIFT_MOVED",
                urgency: "URGENT",
                batchId: null,
                payload: {
                    before: { date: "10.08", time: "10:00-18:00", location: "Гулівер" },
                    after: { date: "11.08", time: "12:00-20:00", location: "<b>Ocean</b>" },
                    reason: "хвороба колеги",
                },
            },
        ]);

        const text = renderDeliveryGroup(group!);

        expect(text).toContain("10.08, 10:00-18:00, Гулівер");
        expect(text).toContain("&lt;b&gt;Ocean&lt;/b&gt;");
        expect(text).not.toContain("<b>Ocean</b>");
        expect(text).toContain("хвороба колеги");
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
