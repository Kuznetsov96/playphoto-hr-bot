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
    const kidlandiaMember = {
        fullName: "Палівода Анастасія Анатоліївна",
        directoryName: "ne1buhay1vino",
        telegramId: "1340583088",
        surnameNameDot: "Палівода А.",
        locationName: "Kidlandia",
    };
    const smileMember = {
        fullName: "Палівода Анна",
        directoryName: "palivoda_smile",
        telegramId: "200000001",
        surnameNameDot: "Палівода А.",
        locationName: "SP Київ",
    };

    it("keeps all schedule sections when a duplicated row label belongs to one staff member", () => {
        expect(service.selectTeamMemberForScheduleRow([kidlandiaMember], locations[0], locations)?.telegramId).toBe("1340583088");
        expect(service.selectTeamMemberForScheduleRow([kidlandiaMember], locations[1], locations)?.telegramId).toBe("1340583088");
    });

    it("uses section location only when multiple staff members share the same row label", () => {
        expect(service.selectTeamMemberForScheduleRow([kidlandiaMember, smileMember], locations[0], locations)?.telegramId).toBe("200000001");
        expect(service.selectTeamMemberForScheduleRow([kidlandiaMember, smileMember], locations[1], locations)?.telegramId).toBe("1340583088");
    });

    it("skips truly ambiguous duplicated labels", () => {
        expect(service.selectTeamMemberForScheduleRow([
            { ...kidlandiaMember, telegramId: "300000001", locationName: "" },
            { ...kidlandiaMember, telegramId: "300000002", locationName: "" },
        ], locations[0], locations)).toBeNull();
    });
});

describe("ScheduleSyncService shift code normalization", () => {
    const service = new ScheduleSyncService() as any;

    it.each(["K", "К", "Ч"])("normalizes Karamel schedule code %s", (code) => {
        expect(service.getShiftCode(code)).toBe("K");
    });
});
