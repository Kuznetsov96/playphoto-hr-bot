import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertSchedulePreference = vi.fn();
const getSchedulePreference = vi.fn();
const findUniqueStaff = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        upsertSchedulePreference: (...a: unknown[]) => upsertSchedulePreference(...a),
        getSchedulePreference: (...a: unknown[]) => getSchedulePreference(...a),
    },
    // Настоящий класс, а не заглушка: писатель различает виды отказа через
    // `instanceof`, и подделка молча увела бы закрытое окно в «бэкенд лежит».
    AwsBusinessApiError: class AwsBusinessApiError extends Error {
        constructor(
            public readonly status: number,
            public readonly code: string | undefined,
            message: string
        ) {
            super(message);
        }
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

    it("reports a distinct reasonCode when the version read itself fails, instead of throwing", async () => {
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
        ).resolves.toEqual({ ok: false, reasonCode: "CANONICAL_PREFERENCE_READ_FAILED" });
        expect(upsertSchedulePreference).not.toHaveBeenCalled();
    });

    it("produces different reasonCodes for a read failure vs a write failure", async () => {
        getSchedulePreference.mockRejectedValueOnce(new Error("HTTP 404"));
        const readResult = await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [1],
            comment: null,
            telegramId: "12345",
            declined: false,
        });

        getSchedulePreference.mockResolvedValueOnce({ exists: false });
        upsertSchedulePreference.mockRejectedValueOnce(new Error("HTTP 503"));
        const writeResult = await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [1],
            comment: null,
            telegramId: "12345",
            declined: false,
        });

        expect(readResult).toEqual({ ok: false, reasonCode: "CANONICAL_PREFERENCE_READ_FAILED" });
        expect(writeResult).toEqual({ ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" });
        expect(readResult).not.toEqual(writeResult);
    });

    it("reports a dedicated reasonCode when the write conflicts with a concurrent edit (HTTP 409)", async () => {
        getSchedulePreference.mockResolvedValue({ exists: true, version: 3 });
        upsertSchedulePreference.mockRejectedValue(new Error("AWS business API request failed with HTTP 409"));

        await expect(
            saveCanonicalPreference({
                staffId: "staff-1",
                month: "2026-09",
                selectedDays: [1],
                comment: null,
                telegramId: "12345",
                declined: false,
            }),
        ).resolves.toEqual({ ok: false, reasonCode: "CANONICAL_PREFERENCE_STALE_VERSION" });
    });

    it("logs operation \"read\" for a read failure and operation \"upsert\" for a write failure", async () => {
        const logger = (await import("../../core/logger.js")).default;
        const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);

        getSchedulePreference.mockRejectedValueOnce(new Error("HTTP 404"));
        await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [1],
            comment: null,
            telegramId: "12345",
            declined: false,
        });

        getSchedulePreference.mockResolvedValueOnce({ exists: false });
        upsertSchedulePreference.mockRejectedValueOnce(new Error("HTTP 503"));
        await saveCanonicalPreference({
            staffId: "staff-1",
            month: "2026-09",
            selectedDays: [1],
            comment: null,
            telegramId: "12345",
            declined: false,
        });

        expect(errorSpy).toHaveBeenCalledTimes(2);
        const [readLogArgs, writeLogArgs] = errorSpy.mock.calls;
        expect(readLogArgs![0]).toMatchObject({ operation: "read", reason_code: "CANONICAL_PREFERENCE_READ_FAILED" });
        expect(writeLogArgs![0]).toMatchObject({ operation: "upsert", reason_code: "CANONICAL_BACKEND_UNAVAILABLE" });
        // safeContext stays counters-only: no telegramId, employee id, or other identifier leaks into the log.
        expect(readLogArgs![0]).toMatchObject({ safe_context: { dayCount: 1 } });
        expect(JSON.stringify(readLogArgs![0])).not.toContain("12345");
        expect(JSON.stringify(readLogArgs![0])).not.toContain("emp-uuid");

        errorSpy.mockRestore();
    });

    it("отличает закрытое окно от устаревшей версии — оба приходят как 409", () => {
        // Устаревшая версия значит «перечитай и попробуй снова», закрытое окно —
        // «поздно, дальше через підміну». Спутать их значит посоветовать
        // опоздавшему «спробуй ще раз за хвилину»: совет, который никогда не
        // сработает.
        return expect(
            (async () => {
                findUniqueStaff.mockResolvedValue({ awsEmployeePublicId: "emp-1" });
                getSchedulePreference.mockResolvedValue({ exists: false });
                const { AwsBusinessApiError } = await import("../aws-business-client.js");
                upsertSchedulePreference.mockRejectedValue(
                    new AwsBusinessApiError(
                        409,
                        "SCHEDULE_PREFERENCES_CLOSED",
                        "AWS business API request failed with HTTP 409"
                    )
                );
                return saveCanonicalPreference({
                    staffId: "staff-1",
                    month: "2026-09",
                    selectedDays: [5],
                    comment: null,
                    telegramId: "5",
                    declined: false,
                });
            })()
        ).resolves.toEqual({ ok: false, reasonCode: "SCHEDULE_PREFERENCES_CLOSED" });
    });
});
