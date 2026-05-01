import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
    findMany: vi.fn(),
}));

vi.mock("../../db/core.js", () => ({
    default: {
        candidate: {
            findMany,
        },
    },
}));

vi.mock("../../utils/shift-time.js", () => ({
    getShiftTimeFromLocationSchedule: vi.fn(),
}));

import { firstShiftOnboardingRepository } from "../first-shift-onboarding-repository.js";

describe("FirstShiftOnboardingRepository auto-open timing", () => {
    beforeEach(() => {
        findMany.mockReset();
    });

    it("opens a 14:00 Kyiv shift during the 13:00 Kyiv auto-open window", async () => {
        const candidate = {
            id: "cand-1",
            firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
            firstShiftTime: "14:00-20:00",
            location: null,
        };
        findMany.mockResolvedValue([candidate]);

        const now = new Date("2026-05-01T10:00:00.000Z");
        const windowEnd = new Date("2026-05-01T11:00:00.000Z");

        const result = await firstShiftOnboardingRepository.findUpcomingCandidatesForAutoOpen(now, windowEnd);

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                firstShiftDate: {
                    gte: new Date("2026-04-30T21:00:00.000Z"),
                    lte: new Date("2026-05-01T20:59:00.000Z"),
                },
            }),
        }));
        expect(result).toEqual([candidate]);
    });
});
