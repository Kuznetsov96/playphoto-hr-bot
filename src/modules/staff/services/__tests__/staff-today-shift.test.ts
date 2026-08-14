import { beforeEach, describe, expect, it, vi } from "vitest";

const getVisibleStaffShifts = vi.fn();

vi.mock("../staff-schedule-view.js", () => ({
    getVisibleStaffShifts: (...a: unknown[]) => getVisibleStaffShifts(...a),
}));

const { getStaffShiftToday } = await import("../staff-today-shift.js");

const KYIV_TODAY = new Date("2026-08-14T00:00:00.000Z");

const shiftOn = (date: Date, overrides: Record<string, unknown> = {}) => ({
    id: "shift-1",
    staffId: "staff-1",
    locationId: "loc-1",
    date,
    startTime: new Date("2026-08-14T11:00:00.000Z"),
    endTime: new Date("2026-08-14T18:00:00.000Z"),
    location: { id: "loc-1", name: "Smile Park", city: "Kyiv", branch: "Troieshchyna" },
    ...overrides,
});

beforeEach(() => {
    getVisibleStaffShifts.mockReset();
});

/**
 * Four screens asked "does she have a shift today" and each answered from the
 * local mirror while the schedule screen answered canonically. The two could
 * disagree for as long as a sync cycle, so a photographer saw a shift on one
 * screen and none on the next. They now share this one reader.
 */
describe("getStaffShiftToday", () => {
    it("reads canonically, the same source the schedule screen uses", async () => {
        getVisibleStaffShifts.mockResolvedValue([shiftOn(KYIV_TODAY)]);

        await getStaffShiftToday("staff-1", KYIV_TODAY);

        expect(getVisibleStaffShifts).toHaveBeenCalledWith(
            "staff-1",
            KYIV_TODAY,
            expect.any(Number),
            expect.objectContaining({ canonicalRead: true }),
        );
    });

    it("returns today's shift when there is one", async () => {
        const today = shiftOn(KYIV_TODAY);
        getVisibleStaffShifts.mockResolvedValue([today]);

        await expect(getStaffShiftToday("staff-1", KYIV_TODAY)).resolves.toMatchObject({ id: "shift-1" });
    });

    /**
     * The nearest shift is not today's shift. Returning tomorrow's would put a
     * photographer on a parcel screen for a location she is not at.
     */
    it("does not mistake a future shift for today's", async () => {
        const tomorrow = new Date("2026-08-15T00:00:00.000Z");
        getVisibleStaffShifts.mockResolvedValue([shiftOn(tomorrow, { id: "shift-tomorrow" })]);

        await expect(getStaffShiftToday("staff-1", KYIV_TODAY)).resolves.toBeNull();
    });

    it("returns null on a day off", async () => {
        getVisibleStaffShifts.mockResolvedValue([]);

        await expect(getStaffShiftToday("staff-1", KYIV_TODAY)).resolves.toBeNull();
    });

    /**
     * A shift she has handed to someone else is not hers to act on: the parcel
     * and hub screens must treat it as a day off, exactly as the schedule screen
     * already does by hiding it.
     */
    it("ignores a shift whose replacement has already been accepted", async () => {
        getVisibleStaffShifts.mockResolvedValue([
            shiftOn(KYIV_TODAY, { isAcceptedReplacementPendingSync: true }),
        ]);

        await expect(getStaffShiftToday("staff-1", KYIV_TODAY)).resolves.toBeNull();
    });

    /**
     * A shift she is still trying to give away remains hers until someone takes
     * it — she is expected to work it, so it must not vanish from the hub.
     */
    it("keeps a shift that is still only searching for a replacement", async () => {
        getVisibleStaffShifts.mockResolvedValue([
            shiftOn(KYIV_TODAY, { isReplacementSearchActive: true }),
        ]);

        await expect(getStaffShiftToday("staff-1", KYIV_TODAY)).resolves.toMatchObject({ id: "shift-1" });
    });
});
