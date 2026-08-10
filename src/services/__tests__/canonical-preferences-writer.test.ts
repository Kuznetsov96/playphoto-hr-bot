import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertSchedulePreference = vi.fn();
const getSchedulePreference = vi.fn();
const findUniqueStaff = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        upsertSchedulePreference: (...a: unknown[]) => upsertSchedulePreference(...a),
        getSchedulePreference: (...a: unknown[]) => getSchedulePreference(...a),
    },
}));
vi.mock("../../db/core.js", () => ({
    default: { staffProfile: { findUnique: (...a: unknown[]) => findUniqueStaff(...a) } },
}));

const { buildPreferenceDays, saveCanonicalPreference } = await import(
    "../canonical-preferences-writer.js"
);

beforeEach(() => {
    upsertSchedulePreference.mockReset();
    getSchedulePreference.mockReset();
    findUniqueStaff.mockReset();
    findUniqueStaff.mockResolvedValue({ awsEmployeePublicId: "emp-uuid" });
    getSchedulePreference.mockResolvedValue({ exists: false });
});

describe("buildPreferenceDays", () => {
    it("marks every selected day as UNAVAILABLE, zero-padded", () => {
        expect(buildPreferenceDays("2026-09", [3, 15])).toEqual([
            { localDate: "2026-09-03", kind: "UNAVAILABLE" },
            { localDate: "2026-09-15", kind: "UNAVAILABLE" },
        ]);
    });

    it("never emits PREFER_NOT_TO_WORK", () => {
        const days = buildPreferenceDays("2026-09", [1, 2, 3]);
        expect(days.every((day) => day.kind === "UNAVAILABLE")).toBe(true);
    });
});

describe("saveCanonicalPreference", () => {
    it("submits the selected days for the mapped employee", async () => {
        upsertSchedulePreference.mockResolvedValue(undefined);

        await expect(
            saveCanonicalPreference({
                staffId: "staff-1",
                month: "2026-09",
                selectedDays: [5],
                comment: "тільки ранкові",
                telegramId: "12345",
                declined: false,
            }),
        ).resolves.toEqual({ ok: true });

        expect(getSchedulePreference).toHaveBeenCalledWith("emp-uuid", "2026-09", "12345");
        expect(upsertSchedulePreference).toHaveBeenCalledWith("emp-uuid", "2026-09", {
            status: "SUBMITTED",
            days: [{ localDate: "2026-09-05", kind: "UNAVAILABLE" }],
            comment: "тільки ранкові",
            telegramId: "12345",
        });
    });

    it("sends the same telegramId to both the read and the write", async () => {
        getSchedulePreference.mockResolvedValue({ exists: true, version: 9 });
        upsertSchedulePreference.mockResolvedValue(undefined);

        await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [5],
            comment: null,
            telegramId: "98765",
            declined: false,
        });

        const readTelegramId = getSchedulePreference.mock.calls[0]![2];
        const writeTelegramId = upsertSchedulePreference.mock.calls[0]![2].telegramId;
        expect(readTelegramId).toBe("98765");
        expect(writeTelegramId).toBe("98765");
        expect(readTelegramId).toBe(writeTelegramId);
    });

    it("sends DECLINED with no days when the employee refuses to fill it in", async () => {
        upsertSchedulePreference.mockResolvedValue(undefined);

        await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [],
            comment: null,
            telegramId: "12345",
            declined: true,
        });

        expect(upsertSchedulePreference.mock.calls[0]![2]).toMatchObject({
            status: "DECLINED",
            days: [],
        });
    });

    it("echoes the existing version so editing preferences does not fail as stale", async () => {
        getSchedulePreference.mockResolvedValue({ exists: true, version: 3 });
        upsertSchedulePreference.mockResolvedValue(undefined);

        await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [7],
            comment: null,
            telegramId: "12345",
            declined: false,
        });

        expect(upsertSchedulePreference.mock.calls[0]![2]).toMatchObject({ version: 3 });
    });

    it("omits version on a first submission, which the backend requires", async () => {
        getSchedulePreference.mockResolvedValue({ exists: false });
        upsertSchedulePreference.mockResolvedValue(undefined);

        await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [7],
            comment: null,
            telegramId: "12345",
            declined: false,
        });

        expect(upsertSchedulePreference.mock.calls[0]![2]).not.toHaveProperty("version");
    });

    it("reports EMPLOYEE_NOT_MAPPED without calling the backend", async () => {
        findUniqueStaff.mockResolvedValue({ awsEmployeePublicId: null });

        await expect(
            saveCanonicalPreference({
                staffId: "staff-1",
                month: "2026-09",
                selectedDays: [1],
                comment: null,
                telegramId: "12345",
                declined: false,
            }),
        ).resolves.toEqual({ ok: false, reasonCode: "EMPLOYEE_NOT_MAPPED" });
        expect(getSchedulePreference).not.toHaveBeenCalled();
        expect(upsertSchedulePreference).not.toHaveBeenCalled();
    });

    it("reports a backend failure instead of throwing", async () => {
        upsertSchedulePreference.mockRejectedValue(new Error("HTTP 503"));

        await expect(
            saveCanonicalPreference({
                staffId: "staff-1",
                month: "2026-09",
                selectedDays: [1],
                comment: null,
                telegramId: "12345",
                declined: false,
            }),
        ).resolves.toEqual({ ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" });
    });

    it("reports a backend failure when the version read itself fails", async () => {
        getSchedulePreference.mockRejectedValue(new Error("HTTP 404"));

        await expect(
            saveCanonicalPreference({
                staffId: "staff-1",
                month: "2026-09",
                selectedDays: [1],
                comment: null,
                telegramId: "12345",
                declined: false,
            }),
        ).resolves.toEqual({ ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" });
        expect(upsertSchedulePreference).not.toHaveBeenCalled();
    });
});
