import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/core.js", () => ({
    default: {
        location: { findMany: vi.fn() },
        candidate: { findMany: vi.fn(), count: vi.fn() }
    }
}));

import { statsService } from "../stats-service.js";

describe("statsService.formatManagementDashboard", () => {
    it("renders management-focused sections including mentor funnel stage", () => {
        const text = statsService.formatManagementDashboard({
            rawTotal: 579,
            rawWeek: 97,
            validTotal: 241,
            validWeek: 42,
            invalidTotal: 338,
            invalidWeek: 55,
            invalidByReason: {
                bot: 12,
                male: 48,
                age: 102,
                noDemand: 133,
                incomplete: 43,
            },
            activeValidPool: 96,
            reserveValidPool: 37,
            hiresWeek: 12,
            losses: {
                screening: 18,
                interview: 44,
                mentorIntro: 9,
                training: 7,
                finalPrep: 5,
                onboarding: 2,
            },
            funnel: {
                validBase: 241,
                interviewTrack: 116,
                hrApproved: 72,
                mentorTrack: 51,
                trainingTrack: 34,
                finalPrep: 19,
                hired: 12,
            },
            health: {
                staleScreening: 19,
                staleWaitlistHr: 0,
                stalledAccepted: 14,
                overdueDiscovery: 4,
                overdueTraining: 2,
                blockers: 1,
                staleFinalStep: 3,
                examples: [],
            },
            locations: [
                {
                    id: "loc1",
                    name: "Smile Park",
                    city: "Warsaw",
                    needed: 12,
                    active: 4,
                    reserve: 7,
                    hiredWeek: 2,
                    gap: 8,
                }
            ],
            actions: [
                "Перевірити джерела трафіку та pre-screening: занадто високий відсів до валідної бази.",
                "Підсилити handoff у mentor track: accepted/discovery/training зависають довше SLA.",
            ],
        } as any, "Warsaw", "Smile Park");

        expect(text).toContain("HR Recruitment Dashboard");
        expect(text).toContain("Mentor intro");
        expect(text).toContain("Validity");
        expect(text).toContain("Losses By Stage");
        expect(text).toContain("Recommended Actions");
        expect(text).toContain("Warsaw / Smile Park");
        expect(text).toContain("Accepted без booking");
    });

    it("shows empty alerts fallback when no SLA issues exist", () => {
        const text = statsService.formatManagementDashboard({
            rawTotal: 10,
            rawWeek: 2,
            validTotal: 8,
            validWeek: 2,
            invalidTotal: 2,
            invalidWeek: 0,
            invalidByReason: {
                bot: 0,
                male: 1,
                age: 1,
                noDemand: 0,
                incomplete: 0,
            },
            activeValidPool: 5,
            reserveValidPool: 1,
            hiresWeek: 1,
            losses: {
                screening: 0,
                interview: 0,
                mentorIntro: 0,
                training: 0,
                finalPrep: 0,
                onboarding: 0,
            },
            funnel: {
                validBase: 8,
                interviewTrack: 5,
                hrApproved: 3,
                mentorTrack: 2,
                trainingTrack: 2,
                finalPrep: 1,
                hired: 1,
            },
            health: {
                staleScreening: 0,
                staleWaitlistHr: 0,
                stalledAccepted: 0,
                overdueDiscovery: 0,
                overdueTraining: 0,
                blockers: 0,
                staleFinalStep: 0,
                examples: [],
            },
            locations: [],
            actions: [
                "Критичних відхилень не виявлено. Сфокусуйтесь на підтриманні швидкості обробки та локаційного балансу."
            ],
        } as any);

        expect(text).toContain("Критичних SLA-відхилень зараз немає");
        expect(text).toContain("Немає активних локацій");
    });
});
