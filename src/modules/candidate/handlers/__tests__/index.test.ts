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

    it("still rejects candidates under 16 at birth date step", async () => {
        const { CandidateSchema } = await import("../index.js");
        const now = new Date();
        const fifteenYearsOld = new Date(now.getFullYear() - 15, now.getMonth(), now.getDate());

        const result = CandidateSchema.shape.birthDate.safeParse(fifteenYearsOld);

        expect(result.success).toBe(false);
    });
});
