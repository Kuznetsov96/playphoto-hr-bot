import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("grammy", () => {
    class MockInlineKeyboard {
        text() { return this; }
        row() { return this; }
    }
    return {
        InlineKeyboard: MockInlineKeyboard,
    };
});

vi.mock("../../db/core.js", () => ({
    default: {
        firstShiftOnboardingCase: {
            findUnique: vi.fn(),
            findMany: vi.fn().mockResolvedValue([]),
        },
        firstShiftOnboardingStep: {
            findUnique: vi.fn(),
        },
        candidate: {
            findFirst: vi.fn(),
        },
    },
}));

vi.mock("../../config.js", () => ({
    FIRST_SHIFT_ONBOARDING_CHAT_ID: -1001234567890,
}));

vi.mock("../../constants/first-shift-onboarding-texts.js", () => ({
    FIRST_SHIFT_ONBOARDING_STEPS: [],
    FIRST_SHIFT_ONBOARDING_TEXTS: {
        completed: "completed",
        topicClosed: "topicClosed",
    },
}));

vi.mock("../../repositories/first-shift-onboarding-repository.js", () => ({
    firstShiftOnboardingRepository: {
        findCaseByCandidateId: vi.fn(),
        updateCase: vi.fn(),
        updateStep: vi.fn(),
        findActiveCaseByCandidateId: vi.fn(),
        findActiveCaseByTopicId: vi.fn(),
        createCase: vi.fn(),
        findUpcomingCandidatesForAutoOpen: vi.fn().mockResolvedValue([]),
    }
}));

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        update: vi.fn(),
    }
}));

vi.mock("../../repositories/timeline-repository.js", () => ({
    timelineRepository: {
        createEvent: vi.fn(),
    }
}));

vi.mock("../../core/log-events.js", () => ({
    logBusinessEvent: vi.fn(),
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    },
}));

vi.mock("../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value,
}));

vi.mock("../../utils/shift-time.js", () => ({
    getShiftTimeFromLocationSchedule: vi.fn(),
}));

import prisma from "../../db/core.js";
import { firstShiftOnboardingRepository } from "../../repositories/first-shift-onboarding-repository.js";
import { candidateRepository } from "../../repositories/candidate-repository.js";
import { firstShiftOnboardingService } from "../first-shift-onboarding-service.js";

describe("FirstShiftOnboardingService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should unlock mentor onboarding when first-shift onboarding passes", async () => {
        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue({
            id: "case-1",
            status: "PENDING_FINAL",
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [],
            topicId: 321,
            chatId: BigInt(-1001234567890),
        } as any);
        vi.mocked(firstShiftOnboardingRepository.updateCase).mockResolvedValue({
            id: "case-1",
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [],
            topicId: 321,
            chatId: BigInt(-1001234567890),
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            closeForumTopic: vi.fn().mockResolvedValue({}),
        };

        await firstShiftOnboardingService.completeCase(api as any, "case-1");

        expect(candidateRepository.update).toHaveBeenCalledWith("cand-1", {
            status: "HIRED",
            isMentorLocked: false,
        });
    });

    it("calculates shift end in Kyiv time for closing flow", () => {
        const shiftEnd = (firstShiftOnboardingService as any).getShiftEndAt({
            candidate: {
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                location: null,
            },
        });

        expect(shiftEnd).toEqual(new Date("2026-05-01T17:00:00.000Z"));
    });

    it("ignores approve for a non-submitted active step", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "laptop_start",
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
            },
            steps: [
                {
                    id: "step-2",
                    key: "laptop_start",
                    order: 2,
                    status: "ACTIVE",
                    inputType: "SCREENSHOT",
                },
            ],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingStep.findUnique).mockResolvedValue({
            id: "step-2",
            caseId: "case-1",
        });
        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue({
            id: "case-1",
            candidateId: "cand-1",
        });
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue(onboardingCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.approveStep(api as any, "step-2", 111);

        expect(result).toBeNull();
        expect(firstShiftOnboardingRepository.updateStep).not.toHaveBeenCalled();
    });
});
