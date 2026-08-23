import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const getSchedulePreference = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: { staffProfile: { findUnique } },
}));
vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: { getSchedulePreference },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { readCanonicalPreferenceDays } = await import("../canonical-preferences-writer.js");

const input = { staffId: "staff-1", month: "2026-09", telegramId: "12345" };

beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue({ awsEmployeePublicId: "emp-uuid" });
});

describe("readCanonicalPreferenceDays", () => {
    it("returns the day numbers already submitted", async () => {
        getSchedulePreference.mockResolvedValue({
            exists: true,
            version: 2,
            status: "SUBMITTED",
            days: [
                { localDate: "2026-09-05", kind: "UNAVAILABLE" },
                { localDate: "2026-09-19", kind: "UNAVAILABLE" },
            ],
        });

        expect(await readCanonicalPreferenceDays(input)).toEqual([5, 19]);
    });

    /**
     * Пустой массив (подала, но ничего не отметила) и `undefined` (не знаем) —
     * разные вещи: календарь по первому объясняет отметки, по второму молчит.
     */
    it("returns an empty list for a submission with no marked days", async () => {
        getSchedulePreference.mockResolvedValue({
            exists: true,
            version: 1,
            status: "SUBMITTED",
            days: [],
        });

        expect(await readCanonicalPreferenceDays(input)).toEqual([]);
    });

    it("returns nothing when the month has no submission", async () => {
        getSchedulePreference.mockResolvedValue({ exists: false });

        expect(await readCanonicalPreferenceDays(input)).toBeUndefined();
    });

    /** Отказ — не набор дней, подставлять из него нечего. */
    it("returns nothing for a declined submission", async () => {
        getSchedulePreference.mockResolvedValue({
            exists: true,
            version: 1,
            status: "DECLINED",
            days: [],
        });

        expect(await readCanonicalPreferenceDays(input)).toBeUndefined();
    });

    /**
     * Сбой сети не должен мешать заполнить график заново: человек увидит пустой
     * календарь, как и раньше, а не ошибку на входе в поток.
     */
    it("stays silent when the backend is unreachable", async () => {
        getSchedulePreference.mockRejectedValue(new Error("HTTP 503"));

        expect(await readCanonicalPreferenceDays(input)).toBeUndefined();
    });

    it("returns nothing for an employee with no canonical mapping", async () => {
        findUnique.mockResolvedValue({ awsEmployeePublicId: null });

        expect(await readCanonicalPreferenceDays(input)).toBeUndefined();
        expect(getSchedulePreference).not.toHaveBeenCalled();
    });
});
