import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("grammy", () => {
    class MockInlineKeyboard {
        buttons: string[] = [];
        text(label: string) {
            this.buttons.push(label);
            return this;
        }
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
        notifyCandidate: () => "notifyCandidate",
        completed: "completed",
        startButton: "start",
        askMentorButton: "ask",
        submittedNoApproval: "submittedNoApproval",
        approved: "approved",
        setupCompleted: "setupCompleted",
        topicSetupCompleted: "topicSetupCompleted",
        topicAllStepsApproved: "topicAllStepsApproved",
        topicClosed: "topicClosed",
        waitingFinal: "waitingFinal",
        questionForwarded: "questionForwarded",
        mentorObservedCandidate: "mentorObservedCandidate",
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
        findByTelegramId: vi.fn(),
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
        vi.useRealTimers();
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

    it("resumes active first-shift onboarding from /start", async () => {
        vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue({
            id: "cand-1",
        } as any);
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue({
            id: "case-1",
            status: "IN_PROGRESS",
            currentStepKey: "laptop_start",
            candidate: {
                user: { telegramId: 123n },
            },
            steps: [
                {
                    id: "step-2",
                    key: "laptop_start",
                    order: 2,
                    block: "Ноутбук",
                    title: "Підготувати ноутбук",
                    prompt: "prompt",
                    status: "ACTIVE",
                    inputType: "SCREENSHOT",
                },
            ],
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.resumeCandidateFlowFromStart(api as any, 123);

        expect(result).toBe(true);
        expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Підготувати ноутбук"), expect.any(Object));
    });

    it("auto-advances non-approved button steps to the next candidate step", async () => {
        const initialCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "stand_opening",
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
            },
            steps: [
                {
                    id: "step-1",
                    key: "stand_opening",
                    order: 1,
                    block: "Відкриття стійки",
                    title: "Відкрити стійку",
                    prompt: "prompt 1",
                    status: "ACTIVE",
                    inputType: "BUTTON",
                    requiresMentorApproval: false,
                },
                {
                    id: "step-2",
                    key: "laptop_start",
                    order: 2,
                    block: "Ноутбук",
                    title: "Підготувати ноутбук",
                    prompt: "prompt 2",
                    status: "LOCKED",
                    inputType: "SCREENSHOT",
                    requiresMentorApproval: true,
                },
            ],
        } as any;

        const advancedCase = {
            ...initialCase,
            currentStepKey: "laptop_start",
            steps: [
                { ...initialCase.steps[0], status: "APPROVED" },
                { ...initialCase.steps[1], status: "ACTIVE" },
            ],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue(initialCase);
        vi.mocked(firstShiftOnboardingRepository.updateStep)
            .mockResolvedValueOnce({ ...initialCase.steps[0], status: "APPROVED" } as any)
            .mockResolvedValueOnce({ ...initialCase.steps[1], status: "ACTIVE" } as any);
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue(advancedCase);
        vi.mocked(firstShiftOnboardingRepository.updateCase).mockResolvedValue(advancedCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.submitButtonStep(api as any, "case-1", 123);

        expect(result).toBe(advancedCase);
        expect(firstShiftOnboardingRepository.updateStep).toHaveBeenNthCalledWith(1, "step-1", expect.objectContaining({
            status: "APPROVED",
        }));
        expect(firstShiftOnboardingRepository.updateStep).toHaveBeenNthCalledWith(2, "step-2", { status: "ACTIVE" });
        expect(firstShiftOnboardingRepository.updateCase).toHaveBeenCalledWith("case-1", {
            currentStepKey: "laptop_start",
            status: "IN_PROGRESS",
        });
        expect(api.sendMessage).toHaveBeenCalledWith(123, expect.stringContaining("Підготувати ноутбук"), expect.any(Object));
    });

    it("does not auto-open first-shift onboarding after shift start has already passed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-01T15:40:00.000Z"));

        vi.mocked(firstShiftOnboardingRepository.findUpcomingCandidatesForAutoOpen).mockResolvedValue([
            {
                id: "cand-past",
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "15:00-17:00",
                location: null,
            },
            {
                id: "cand-upcoming",
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "19:00-21:00",
                location: null,
            },
        ] as any);

        const notifySpy = vi.spyOn(firstShiftOnboardingService, "notifyCandidate").mockResolvedValue({} as any);

        await firstShiftOnboardingService.autoOpenUpcomingCases({ api: {} } as any);

        expect(notifySpy).toHaveBeenCalledTimes(1);
        expect(notifySpy).toHaveBeenCalledWith({}, "cand-upcoming");
    });

    it("does not copy plain text candidate messages into the onboarding topic twice", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue({
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "photoshop_practice",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-1",
                    key: "photoshop_practice",
                    order: 11,
                    block: "Photoshop + макети",
                    title: "Практика в макетах",
                    prompt: "prompt",
                    status: "ACTIVE",
                    inputType: "MENTOR_OBSERVED",
                    requiresMentorApproval: true,
                },
            ],
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            copyMessage: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            text: "Потрібна допомога",
            messageId: 99,
            chatId: 123,
        });

        expect(handled).toBe(true);
        expect(api.copyMessage).not.toHaveBeenCalled();
        expect(api.sendMessage).toHaveBeenCalledWith(
            -1001234567890,
            expect.stringContaining("Потрібна допомога"),
            expect.objectContaining({ message_thread_id: 42 })
        );
    });

    it("keeps routing messages to the onboarding topic while waiting for the final mentor decision", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue({
            id: "case-1",
            candidateId: "cand-1",
            status: "PENDING_FINAL",
            currentStepKey: null,
            chatId: BigInt(-1001234567890),
            topicId: 42,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [],
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            copyMessage: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            text: "Потрібна допомога",
            messageId: 99,
            chatId: 123,
        });

        expect(handled).toBe(true);
        expect(api.sendMessage).toHaveBeenCalledWith(
            -1001234567890,
            expect.stringContaining("Потрібна допомога"),
            expect.objectContaining({ message_thread_id: 42 })
        );
        expect(api.sendMessage).toHaveBeenLastCalledWith(
            123,
            expect.stringContaining("waitingFinal"),
            expect.any(Object)
        );
    });

    it("does not show final decision buttons on regular mentor case updates", () => {
        const keyboard = (firstShiftOnboardingService as any).buildMentorCaseKeyboard({
            id: "case-1",
            steps: [
                {
                    id: "step-1",
                    key: "laptop_start",
                    order: 1,
                    status: "SUBMITTED",
                    inputType: "SCREENSHOT",
                },
            ],
        });

        expect(keyboard.buttons).toContain("✅ Approve");
        expect(keyboard.buttons).toContain("🔁 Redo");
        expect(keyboard.buttons).not.toContain("✅ Complete Successfully");
        expect(keyboard.buttons).not.toContain("❌ Mark as Failed");
    });
});
