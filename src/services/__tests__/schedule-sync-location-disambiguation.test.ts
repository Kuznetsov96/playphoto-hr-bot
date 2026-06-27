import { describe, expect, it } from "vitest";
import { ScheduleSyncService } from "../schedule-sync.js";

const locations = [
    {
        id: "loc-smile-kyiv",
        name: "Smile Park (Troieshchyna)",
        legacyName: "SP Київ",
        city: "Київ",
    },
    {
        id: "loc-kidlandia",
        name: "Kidlandia",
        legacyName: null,
        city: "Київ",
    },
] as any;

describe("ScheduleSyncService staff label disambiguation", () => {
    const service = new ScheduleSyncService() as any;
    const member = {
        fullName: "Палівода Анастасія Анатоліївна",
        directoryName: "ne1buhay1vino",
        telegramId: "1340583088",
        surnameNameDot: "Палівода А.",
        locationName: "Kidlandia",
    };

    it("uses member location to skip duplicated labels from other schedule sections", () => {
        expect(service.shouldUseScheduleRowForMember(member, locations[0], locations, 2)).toBe(false);
        expect(service.shouldUseScheduleRowForMember(member, locations[1], locations, 2)).toBe(true);
    });

    it("keeps existing behavior for unique labels or unknown member locations", () => {
        expect(service.shouldUseScheduleRowForMember(member, locations[0], locations, 1)).toBe(true);
        expect(service.shouldUseScheduleRowForMember({ ...member, locationName: "" }, locations[0], locations, 2)).toBe(true);
    });
});
