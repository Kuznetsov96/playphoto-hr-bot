import { describe, expect, it, vi } from "vitest";
import { readSelectableShiftsSource, rejectShiftsWithActiveRequest } from "../replacement-selectable-shifts.js";

const shift = (id: string, date: string) => ({
    id,
    staffId: "staff-1",
    locationId: "loc-1",
    date: new Date(`${date}T00:00:00.000Z`),
    startTime: new Date(`${date}T08:00:00.000Z`),
    endTime: new Date(`${date}T17:00:00.000Z`),
    location: { id: "loc-1", name: "Smile Park", city: "Київ", branch: null, schedule: null, openingHours: [] }
});

describe("readSelectableShiftsSource", () => {
    it("бере зміни з канону, коли той відповідає", async () => {
        const canonical = vi.fn().mockResolvedValue([shift("s-1", "2026-09-20")]);
        const mirror = vi.fn();
        const log = vi.fn();

        const result = await readSelectableShiftsSource("staff-1", new Date("2026-09-14"), 62, { canonical, mirror, log });

        expect(result.source).toBe("canonical");
        expect(result.shifts).toHaveLength(1);
        expect(mirror).not.toHaveBeenCalled();
        expect(canonical).toHaveBeenCalledWith("staff-1", new Date("2026-09-14"), 62);
    });

    it("падає на дзеркало і називає причину, коли канон недоступний", async () => {
        const canonical = vi.fn().mockRejectedValue(new Error("boom"));
        const mirror = vi.fn().mockResolvedValue([shift("s-2", "2026-09-21")]);
        const log = vi.fn();

        const result = await readSelectableShiftsSource("staff-1", new Date("2026-09-14"), 62, { canonical, mirror, log });

        expect(result.source).toBe("mirror");
        expect(result.shifts).toHaveLength(1);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "CANONICAL_SCHEDULE_UNAVAILABLE" }));
    });

    it("зберігає reasonCode канонічної помилки, коли він відомий", async () => {
        const { CanonicalScheduleReadError } = await import("../aws-schedule-canonical-projector.js");
        const canonical = vi.fn().mockRejectedValue(new CanonicalScheduleReadError("EMPLOYEE_NOT_MAPPED"));
        const mirror = vi.fn().mockResolvedValue([]);
        const log = vi.fn();

        await readSelectableShiftsSource("staff-1", new Date("2026-09-14"), 62, { canonical, mirror, log });

        expect(log).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: "EMPLOYEE_NOT_MAPPED" }));
    });
});

describe("rejectShiftsWithActiveRequest", () => {
    it("прибирає зміни, для яких пошук уже триває", () => {
        const shifts = [shift("s-1", "2026-09-20"), shift("s-2", "2026-09-21")];

        const result = rejectShiftsWithActiveRequest(shifts, new Set(["s-1"]));

        expect(result.map(row => row.id)).toEqual(["s-2"]);
    });

    it("не чіпає список, коли активних заявок немає", () => {
        const shifts = [shift("s-1", "2026-09-20")];

        expect(rejectShiftsWithActiveRequest(shifts, new Set())).toHaveLength(1);
    });
});
