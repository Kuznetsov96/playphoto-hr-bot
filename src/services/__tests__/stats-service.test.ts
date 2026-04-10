import { CandidateStatus, FunnelStep } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/core.js", () => ({
    default: {
        location: { findMany: vi.fn(), findUnique: vi.fn() },
        candidate: { findMany: vi.fn(), count: vi.fn() }
    }
}));

import { statsService } from "../stats-service.js";
import prisma from "../../db/core.js";

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

    it("renders Ukrainian city names in English for the HR stats UI", () => {
        const text = statsService.formatManagementDashboard({
            rawTotal: 5,
            rawWeek: 1,
            validTotal: 5,
            validWeek: 1,
            invalidTotal: 0,
            invalidWeek: 0,
            invalidByReason: {
                bot: 0,
                male: 0,
                age: 0,
                noDemand: 0,
                incomplete: 0,
            },
            activeValidPool: 1,
            reserveValidPool: 0,
            hiresWeek: 0,
            losses: {
                screening: 0,
                interview: 0,
                mentorIntro: 0,
                training: 0,
                finalPrep: 0,
                onboarding: 0,
            },
            funnel: {
                validBase: 5,
                interviewTrack: 1,
                hrApproved: 1,
                mentorTrack: 0,
                trainingTrack: 0,
                finalPrep: 0,
                hired: 0,
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
            locations: [
                {
                    id: "loc-kyiv",
                    name: "Smile Park",
                    city: "Київ",
                    needed: 1,
                    active: 1,
                    reserve: 0,
                    hiredWeek: 0,
                    gap: 0,
                }
            ],
            actions: [
                "Критичних відхилень не виявлено. Сфокусуйтесь на підтриманні швидкості обробки та локаційного балансу."
            ],
        } as any, "Київ");

        expect(text).toContain("City: <b>Kyiv</b>");
        expect(text).toContain("Kyiv / Smile Park");
        expect(text).not.toContain("City: <b>Київ</b>");
    });

    it("uses the selected location city instead of stale session city", async () => {
        const dashboardData = {
            rawTotal: 0,
            rawWeek: 0,
            validTotal: 0,
            validWeek: 0,
            invalidTotal: 0,
            invalidWeek: 0,
            invalidByReason: {
                bot: 0,
                male: 0,
                age: 0,
                noDemand: 0,
                incomplete: 0,
            },
            activeValidPool: 0,
            reserveValidPool: 0,
            hiresWeek: 0,
            losses: {
                screening: 0,
                interview: 0,
                mentorIntro: 0,
                training: 0,
                finalPrep: 0,
                onboarding: 0,
            },
            funnel: {
                validBase: 0,
                interviewTrack: 0,
                hrApproved: 0,
                mentorTrack: 0,
                trainingTrack: 0,
                finalPrep: 0,
                hired: 0,
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
            actions: ["Критичних відхилень не виявлено."],
        } as any;
        const getDataSpy = vi.spyOn(statsService, "getManagementDashboardData").mockResolvedValueOnce(dashboardData);
        vi.mocked(prisma.location.findUnique).mockResolvedValueOnce({ name: "Fly Kids", city: "Київ" } as any);

        try {
            const text = await statsService.buildManagementDashboard("Хмельницький", "loc-kyiv", "Fly Kids (Київ)");

            expect(text).toContain("City: <b>Kyiv</b>");
            expect(text).toContain("Location: <b>Fly Kids</b>");
            expect(text).not.toContain("City: <b>Khmelnytskyi</b>");
            expect(text).not.toContain("Fly Kids (Київ)");
        } finally {
            getDataSpy.mockRestore();
        }
    });
});

describe("statsService.getManagementDashboardData", () => {
    it("does not count stale isWaitlisted flags as reserve or active pool", async () => {
        const health = {
            staleScreening: 0,
            staleWaitlistHr: 0,
            stalledAccepted: 0,
            overdueDiscovery: 0,
            overdueTraining: 0,
            blockers: 0,
            staleFinalStep: 0,
            examples: [],
        };
        vi.spyOn(statsService, "getPipelineHealthReport").mockResolvedValueOnce(health);

        const location = {
            id: "loc-khm",
            name: "Dytyache Horyshche",
            city: "Хмельницький",
            neededCount: 3,
            isHidden: false,
        };
        vi.mocked(prisma.location.findMany).mockResolvedValueOnce([location] as any);

        const validUser = { createdAt: new Date("2026-04-01T00:00:00.000Z"), botBlockedAt: null };
        const birthDate = new Date("2003-01-01T00:00:00.000Z");
        const baseCandidate = {
            fullName: "Candidate",
            currentStep: FunnelStep.INTERVIEW,
            isOtherCity: false,
            gender: "female",
            birthDate,
            hrDecision: null,
            candidateDecision: null,
            lossStage: null,
            lossReason: null,
            lostAt: null,
            statusChangedAt: null,
            pipelineTouchedAt: new Date("2026-04-01T00:00:00.000Z"),
            locationId: location.id,
            user: validUser,
        };

        vi.mocked(prisma.candidate.findMany).mockResolvedValueOnce([
            {
                ...baseCandidate,
                status: CandidateStatus.SCREENING,
                isWaitlisted: true,
            },
            {
                ...baseCandidate,
                status: CandidateStatus.REJECTED,
                isWaitlisted: true,
            },
            {
                ...baseCandidate,
                status: CandidateStatus.WAITLIST_HR,
                isWaitlisted: false,
            },
            {
                ...baseCandidate,
                status: CandidateStatus.WAITLIST_HR,
                isWaitlisted: true,
            },
            {
                ...baseCandidate,
                status: CandidateStatus.SCREENING,
                isWaitlisted: false,
            },
        ] as any);

        const data = await statsService.getManagementDashboardData("Хмельницький");

        expect(data.activeValidPool).toBe(1);
        expect(data.reserveValidPool).toBe(1);
        expect(data.locations[0]).toMatchObject({
            active: 1,
            reserve: 1,
        });
    });
});
