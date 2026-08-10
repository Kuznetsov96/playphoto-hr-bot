import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the real sendDailyShiftReminders wiring with the canonical reminders
// flag on: the delivery loop reads shift.staff.user.telegramId, shift.staff.id
// and shift.staff.fullName off whatever readShifts() returns, through an `as any`
// cast that TypeScript cannot check. This test proves the canonical path attaches
// a staff profile that satisfies the loop, and that any canonical failure falls
// back to the legacy repository so a reminder is never lost.
const mocks = vi.hoisted(() => ({
    canonicalFindForStaff: vi.fn(),
    legacyFindWithRelations: vi.fn(),
    staffProfileFindMany: vi.fn(),
    listAcceptedAssignmentsByDateRange: vi.fn(),
    getStaffActiveTasks: vi.fn(),
    parcelCount: vi.fn(),
    redisSet: vi.fn(),
    redisDel: vi.fn(),
    logEvent: vi.fn()
}));

vi.mock("../../config.js", () => ({ AWS_REMINDERS_CANONICAL_READ_ENABLED: true }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: mocks.logEvent }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: { findWithRelationsByDateRange: mocks.legacyFindWithRelations }
}));
vi.mock("../replacement-service.js", () => ({
    replacementService: { listAcceptedAssignmentsByDateRange: mocks.listAcceptedAssignmentsByDateRange }
}));
vi.mock("../task-service.js", () => ({
    taskService: { getStaffActiveTasks: mocks.getStaffActiveTasks }
}));
vi.mock("../../db/core.js", () => ({
    default: {
        staffProfile: { findMany: mocks.staffProfileFindMany },
        parcel: { count: mocks.parcelCount }
    }
}));
vi.mock("../../core/redis.js", () => ({
    redis: { set: mocks.redisSet, del: mocks.redisDel }
}));
vi.mock("../aws-schedule-canonical-read.js", () => ({
    awsScheduleCanonicalReadService: { findForStaff: mocks.canonicalFindForStaff }
}));

import { sendDailyShiftReminders } from "../shift-reminder-service.js";

const location = { id: "location-1", name: "Volkland 3 (Перемоги)", schedule: "10:00-20:00" };
const staffProfile = {
    id: "staff-1",
    fullName: "Виниченко Вікторія",
    awsEmployeePublicId: "aws-staff-1",
    user: { telegramId: 1311338839n }
};

function canonicalShiftFor(date: Date) {
    return {
        id: "canonical-shift-1",
        staffId: "staff-1",
        locationId: "location-1",
        date,
        startTime: new Date(date.getTime() + 9 * 60 * 60 * 1000),
        endTime: new Date(date.getTime() + 18 * 60 * 60 * 1000),
        location
    };
}

describe("sendDailyShiftReminders canonical wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listAcceptedAssignmentsByDateRange.mockResolvedValue([]);
        mocks.getStaffActiveTasks.mockResolvedValue([]);
        mocks.parcelCount.mockResolvedValue(0);
        mocks.redisSet.mockResolvedValue("OK");
        mocks.redisDel.mockResolvedValue(1);
        mocks.staffProfileFindMany.mockResolvedValue([staffProfile]);
        mocks.legacyFindWithRelations.mockResolvedValue([]);
    });

    it("attaches the staff profile to canonical shifts so the delivery loop can send", async () => {
        const now = new Date();
        const kyivToday = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Kyiv",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(now);
        const todayUtcMidnight = new Date(`${kyivToday}T00:00:00.000Z`);

        mocks.canonicalFindForStaff.mockResolvedValue([canonicalShiftFor(todayUtcMidnight)]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(mocks.canonicalFindForStaff).toHaveBeenCalledWith("staff-1", expect.any(Date), 5);
        expect(mocks.legacyFindWithRelations).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledWith(
            1311338839,
            expect.stringContaining("Volkland 3"),
            expect.objectContaining({ parse_mode: "HTML" })
        );
        expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: "bot.reminders_canonical_read.succeeded",
            result: "success"
        }));
    });

    it("falls back to the legacy repository and still delivers when canonical read throws", async () => {
        mocks.canonicalFindForStaff.mockRejectedValue(new Error("canonical backend unavailable"));
        mocks.legacyFindWithRelations.mockResolvedValue([{
            id: "legacy-shift-1",
            staffId: "staff-1",
            locationId: "location-1",
            date: new Date(),
            staff: staffProfile,
            location
        }]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        await sendDailyShiftReminders({ api: { sendMessage } } as any);

        expect(mocks.legacyFindWithRelations).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledWith(
            1311338839,
            expect.stringContaining("Volkland 3"),
            expect.objectContaining({ parse_mode: "HTML" })
        );
        expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({
            event: "bot.reminders_canonical_read.fallback",
            result: "fallback",
            reasonCode: "CANONICAL_SCHEDULE_UNAVAILABLE"
        }));
    });

    it("drops a canonical shift whose staff profile is missing instead of throwing", async () => {
        mocks.staffProfileFindMany.mockResolvedValue([staffProfile]);
        const now = new Date();
        const kyivToday = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Kyiv",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(now);
        const todayUtcMidnight = new Date(`${kyivToday}T00:00:00.000Z`);

        // Canonical read returns a shift for a staffId that was not in the
        // active/mapped profile list fetched moments earlier (e.g. deactivated
        // mid-request). The loop must not crash on the missing staff relation.
        mocks.canonicalFindForStaff.mockResolvedValue([
            { ...canonicalShiftFor(todayUtcMidnight), staffId: "ghost-staff" }
        ]);

        const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        await expect(sendDailyShiftReminders({ api: { sendMessage } } as any)).resolves.not.toThrow();

        expect(sendMessage).not.toHaveBeenCalled();
    });
});
