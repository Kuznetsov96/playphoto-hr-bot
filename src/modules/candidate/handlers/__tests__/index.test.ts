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

    it("marks candidates under 17 for deferred underage handling at the birth date step", async () => {
        const { shouldDeferCandidateAtBirthDate } = await import("../index.js");
        const now = new Date();
        const fifteenYearsOld = new Date(now.getFullYear() - 15, now.getMonth(), now.getDate());
        const sixteenYearsOld = new Date(now.getFullYear() - 16, now.getMonth(), now.getDate());
        const seventeenYearsOld = new Date(now.getFullYear() - 17, now.getMonth(), now.getDate());

        expect(shouldDeferCandidateAtBirthDate(fifteenYearsOld)).toBe(true);
        // 16 більше не проходить: поріг єдиний для всіх локацій (17), тож
        // відмова приходить одразу, а не через два кроки після вибору локації.
        expect(shouldDeferCandidateAtBirthDate(sixteenYearsOld)).toBe(true);
        expect(shouldDeferCandidateAtBirthDate(seventeenYearsOld)).toBe(false);
    });

    it("rejects impossible birth dates", async () => {
        const { CandidateSchema } = await import("../index.js");
        const futureDate = new Date();
        futureDate.setFullYear(futureDate.getFullYear() + 1);

        expect(CandidateSchema.shape.birthDate.safeParse(new Date("1949-12-31T00:00:00.000Z")).success).toBe(false);
        expect(CandidateSchema.shape.birthDate.safeParse(futureDate).success).toBe(false);
    });
});

describe("resolveScreeningStatus", () => {
    it("ставит MANUAL_REVIEW, даже когда мест нет: ревью внешности не зависит от вакансии", async () => {
        const { resolveScreeningStatus } = await import("../index.js");

        expect(resolveScreeningStatus({ hasVacancy: false, appearance: "[Фото]" })).toBe("MANUAL_REVIEW");
    });

    it("без особенностей и без мест — WAITLIST_HR", async () => {
        const { resolveScreeningStatus } = await import("../index.js");

        expect(resolveScreeningStatus({ hasVacancy: false, appearance: "Без особливостей" })).toBe("WAITLIST_HR");
    });

    it("без особенностей и с местом — SCREENING", async () => {
        const { resolveScreeningStatus } = await import("../index.js");

        expect(resolveScreeningStatus({ hasVacancy: true, appearance: "Без особливостей" })).toBe("SCREENING");
    });

    it("не отправляет на ревью из-за старой дописки о нескольких локациях", async () => {
        const { resolveScreeningStatus } = await import("../index.js");

        // Анкеты до 09.09.2026 хранят выбор локаций прямо в appearance.
        // Ревью внешности к нему отношения не имеет.
        expect(
            resolveScreeningStatus({
                hasVacancy: true,
                appearance: "Без особливостей\n(Обрані локації: Volkland, Smile Park)",
            }),
        ).toBe("SCREENING");

        expect(
            resolveScreeningStatus({
                hasVacancy: false,
                appearance: "Без особливостей\n(Обрані локації: Volkland, Smile Park)",
            }),
        ).toBe("WAITLIST_HR");
    });

    it("особенности есть и место есть — MANUAL_REVIEW", async () => {
        const { resolveScreeningStatus } = await import("../index.js");

        expect(resolveScreeningStatus({ hasVacancy: true, appearance: "пірсинг у носі" })).toBe("MANUAL_REVIEW");
    });
});

describe("finishScreening: защита от двойного тапа", () => {
    function makeCtx(overrides: Record<string, any> = {}) {
        return {
            session: {
                step: "screening_source",
                candidateData: { source: "Instagram", ...overrides },
            },
            from: { id: 1 },
            update: { update_id: 1 },
            di: {
                locationRepository: { findById: vi.fn() },
                candidateRepository: { upsert: vi.fn(async () => ({})) },
                userRepository: { upsert: vi.fn(async () => ({ id: "u1" })) },
            },
        } as any;
    }

    it("второй вызов на том же шаге не доходит до финализации", async () => {
        const { finishScreening } = await import("../index.js");
        const { ScreenManager } = await import("../../../../utils/screen-manager.js");
        const ctx = makeCtx();

        // Прогоняем финализацию до конца первого вызова: шаг уже помечен
        // как «финализируется», и повторный тап должен выйти сразу.
        ctx.session.step = "screening_finishing";
        vi.mocked(ScreenManager.renderScreen).mockClear();

        await finishScreening(ctx, "Без особливостей");

        expect(ScreenManager.renderScreen).not.toHaveBeenCalled();
    });

    it("после завершения анкеты (idle) повторный тап тоже игнорируется", async () => {
        const { finishScreening } = await import("../index.js");
        const { ScreenManager } = await import("../../../../utils/screen-manager.js");
        const ctx = makeCtx();

        ctx.session.step = "idle";
        vi.mocked(ScreenManager.renderScreen).mockClear();

        await finishScreening(ctx, "Без особливостей");

        expect(ScreenManager.renderScreen).not.toHaveBeenCalled();
    });

    it("без выбранного источника ведёт на вопрос об источнике, а не финализирует", async () => {
        const { finishScreening } = await import("../index.js");
        const { ScreenManager } = await import("../../../../utils/screen-manager.js");
        const ctx = makeCtx();
        ctx.session.candidateData.source = undefined;
        vi.mocked(ScreenManager.renderScreen).mockClear();

        await finishScreening(ctx, "Без особливостей");

        expect(ctx.session.step).toBe("screening_source");
    });
});
