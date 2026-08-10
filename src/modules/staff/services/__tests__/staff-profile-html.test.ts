import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findShifts: vi.fn(),
    findEarliestShift: vi.fn(),
    findLocation: vi.fn(),
    findCandidate: vi.fn()
}));

vi.mock("../../../../config.js", () => ({ TEAM_CHANNEL_LINK: "https://example.com/team" }));
vi.mock("../../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: {
        findWithLocationForStaff: mocks.findShifts,
        findEarliestShift: mocks.findEarliestShift
    }
}));
vi.mock("../../../../repositories/location-repository.js", () => ({
    locationRepository: { findById: mocks.findLocation }
}));
vi.mock("../../../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByUserId: mocks.findCandidate }
}));

import { StaffService } from "../index.js";

describe("StaffService profile HTML", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findShifts.mockResolvedValue([]);
        mocks.findEarliestShift.mockResolvedValue(null);
        mocks.findLocation.mockResolvedValue({
            id: "location-1",
            name: "Kids <Center> & Co",
            city: "Kyiv"
        });
        mocks.findCandidate.mockResolvedValue(null);
    });

    it("escapes employee fields before rendering Telegram HTML", async () => {
        const service = new StaffService();
        const text = await service.getProfileText(
            {
                id: "staff-1",
                userId: "user-1",
                fullName: "Лаврик Дар'я <test>",
                phone: "+380 <123> & 45",
                locationId: "location-1",
                user: { username: "darya&team" }
            } as any,
            false,
            "SUPER_ADMIN"
        );

        expect(text).toContain("Лаврик Дар'я (@darya&amp;team)");
        expect(text).toContain("+380 &lt;123&gt; &amp; 45");
        expect(text).toContain("Kids &lt;Center&gt; &amp; Co");
        expect(text).not.toContain("<test>");
    });
});
