import { beforeEach, describe, expect, it, vi } from "vitest";

const { findWithShiftAtLocation, findByLocation } = vi.hoisted(() => ({
    findWithShiftAtLocation: vi.fn(),
    findByLocation: vi.fn(),
}));

vi.mock("../../../repositories/staff-repository.js", () => ({
    staffRepository: { findWithShiftAtLocation, findByLocation },
}));

import { getTaskCreationStaffCached } from "../task-creation.js";
import type { MyContext } from "../../../types/context.js";

function makeCtx(taskCreation: NonNullable<MyContext["session"]["taskCreation"]> | undefined) {
    return { session: { taskCreation } } as unknown as MyContext;
}

const STAFF_A = [{ id: "staff-a", fullName: "Alice" }] as any;
const STAFF_B = [{ id: "staff-b", fullName: "Bob" }] as any;

describe("getTaskCreationStaffCached", () => {
    beforeEach(() => {
        findWithShiftAtLocation.mockReset();
        findByLocation.mockReset();
        findWithShiftAtLocation.mockResolvedValue([]);
        findByLocation.mockResolvedValue(STAFF_A);
    });

    it("queries the DB once across repeated calls for the same (locationId, date) pair", async () => {
        findWithShiftAtLocation.mockResolvedValue(STAFF_A);
        const ctx = makeCtx({ step: "selecting_staff" });

        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");
        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");
        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");

        // Toggling a staff checkbox re-renders the same screen 3 times; without the memo
        // this would be 3 DB round trips (findWithShiftAtLocation, since a date is given).
        expect(findWithShiftAtLocation).toHaveBeenCalledTimes(1);
        expect(findByLocation).not.toHaveBeenCalled();
    });

    it("refetches when the location changes, even with the same date", async () => {
        const ctx = makeCtx({ step: "selecting_staff" });
        findByLocation.mockResolvedValueOnce(STAFF_A).mockResolvedValueOnce(STAFF_B);

        const first = await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");
        const second = await getTaskCreationStaffCached(ctx, "loc-2", "2026-09-20");

        expect(findByLocation).toHaveBeenCalledTimes(2);
        expect(first.staff).toEqual(STAFF_A);
        expect(second.staff).toEqual(STAFF_B);
    });

    it("refetches when the date changes, even with the same location", async () => {
        const ctx = makeCtx({ step: "selecting_staff" });

        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");
        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-21");

        expect(findByLocation).toHaveBeenCalledTimes(2);
    });

    it("returns the same staff list and source the underlying lookup would have given", async () => {
        findWithShiftAtLocation.mockResolvedValue(STAFF_A);
        const ctx = makeCtx({ step: "selecting_staff" });

        const result = await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");

        expect(result).toEqual({ staff: STAFF_A, source: "schedule" });
    });

    it("falls through to an uncached lookup when there is no taskCreation session yet", async () => {
        findWithShiftAtLocation.mockResolvedValue(STAFF_A);
        const ctx = makeCtx(undefined);

        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");
        await getTaskCreationStaffCached(ctx, "loc-1", "2026-09-20");

        // No session slot to memoize into — each call hits the DB.
        expect(findWithShiftAtLocation).toHaveBeenCalledTimes(2);
    });
});
