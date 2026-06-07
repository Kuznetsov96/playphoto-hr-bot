import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../core/logger.js", () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }
}));

vi.mock("../../../../utils/screen-manager.js", () => ({
    ScreenManager: {
        renderScreen: vi.fn(),
    }
}));

vi.mock("../../../../utils/menu-registry.js", () => ({
    menuRegistry: {
        register: vi.fn(),
    }
}));

describe("candidate screening birth date validation", () => {
    it("allows age-limit candidates to continue the questionnaire", async () => {
        const { CandidateSchema } = await import("../index.js");

        const result = CandidateSchema.shape.birthDate.safeParse(new Date("1990-05-15T00:00:00.000Z"));

        expect(result.success).toBe(true);
    });

    it("allows 16-year-old candidates to continue until location is known", async () => {
        const { CandidateSchema } = await import("../index.js");
        const now = new Date();
        const sixteenYearsOld = new Date(now.getFullYear() - 16, now.getMonth(), now.getDate());

        const result = CandidateSchema.shape.birthDate.safeParse(sixteenYearsOld);

        expect(result.success).toBe(true);
    });

    it("accepts real birth dates even when the candidate is under 16", async () => {
        const { CandidateSchema } = await import("../index.js");
        const now = new Date();
        const fifteenYearsOld = new Date(now.getFullYear() - 15, now.getMonth(), now.getDate());

        const result = CandidateSchema.shape.birthDate.safeParse(fifteenYearsOld);

        expect(result.success).toBe(true);
    });

    it("marks candidates under 16 for deferred underage handling at the birth date step", async () => {
        const { shouldDeferCandidateAtBirthDate } = await import("../index.js");
        const now = new Date();
        const fifteenYearsOld = new Date(now.getFullYear() - 15, now.getMonth(), now.getDate());
        const sixteenYearsOld = new Date(now.getFullYear() - 16, now.getMonth(), now.getDate());

        expect(shouldDeferCandidateAtBirthDate(fifteenYearsOld)).toBe(true);
        expect(shouldDeferCandidateAtBirthDate(sixteenYearsOld)).toBe(false);
    });

    it("rejects impossible birth dates", async () => {
        const { CandidateSchema } = await import("../index.js");
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        expect(CandidateSchema.shape.birthDate.safeParse(new Date("1949-12-31T00:00:00.000Z")).success).toBe(false);
        expect(CandidateSchema.shape.birthDate.safeParse(futureDate).success).toBe(false);
    });
});
