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
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
        topicOpened: "topicOpened",
        topicStarted: "topicStarted",
        submittedNoApproval: "submittedNoApproval",
        submitted: "submitted",
        approved: "approved",
        rejected: () => "rejected",
        closingOpened: "closingOpened",
        setupCompleted: "setupCompleted",
        topicSetupCompleted: "topicSetupCompleted",
        topicAllStepsApproved: "topicAllStepsApproved",
        topicClosed: "topicClosed",
        topicFailed: "topicFailed",
        topicClosingOpened: "topicClosingOpened",
        waitingFinal: "waitingFinal",
        questionForwarded: "questionForwarded",
        mentorObservedCandidate: "mentorObservedCandidate",
        sendPhotoExpected: "sendPhotoExpected",
        sendTextExpected: "sendTextExpected",
        multiplePhotosHint: "multiplePhotosHint",
        multiplePhotosDoneButton: "multiplePhotosDoneButton",
        failed: "failed",
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
        claimEntryMessageDelivery: vi.fn(),
        markEntryMessageDelivered: vi.fn(),
        releaseEntryMessageDelivery: vi.fn(),
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
        vi.mocked((prisma as any).firstShiftOnboardingStep.updateMany).mockResolvedValue({ count: 1 });
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

    it("auto-opens the closing flow only near shift end, not for stale past shifts", () => {
        vi.useFakeTimers();

        const onboardingCase = {
            candidate: {
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                location: null,
            },
        } as any;

        vi.setSystemTime(new Date("2026-05-01T16:29:59.000Z"));
        expect((firstShiftOnboardingService as any).canAutoOpenClosingNow(onboardingCase)).toBe(false);

        vi.setSystemTime(new Date("2026-05-01T16:30:00.000Z"));
        expect((firstShiftOnboardingService as any).canAutoOpenClosingNow(onboardingCase)).toBe(true);

        vi.setSystemTime(new Date("2026-05-01T18:59:59.000Z"));
        expect((firstShiftOnboardingService as any).canAutoOpenClosingNow(onboardingCase)).toBe(true);

        vi.setSystemTime(new Date("2026-05-01T19:00:01.000Z"));
        expect((firstShiftOnboardingService as any).canAutoOpenClosingNow(onboardingCase)).toBe(false);

        vi.setSystemTime(new Date("2026-05-07T09:17:00.000Z"));
        expect((firstShiftOnboardingService as any).canAutoOpenClosingNow(onboardingCase)).toBe(false);
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

    it("does not resend the entry message when notifyCandidate is called repeatedly for the same case", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            topicId: 137,
            chatId: BigInt(-1001234567890),
            entryMessageSentAt: new Date("2026-05-05T10:00:00.000Z"),
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                fullName: "Бачук Вікторія Вікторівна",
                firstName: "Вікторія",
                username: "vvvbach",
                location: { name: "Karamel" },
                city: "Коломия",
                firstShiftDate: new Date("2026-05-05T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                firstShiftPartner: null,
            },
            steps: [],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.findCaseByCandidateId).mockResolvedValue(onboardingCase);

        const api = {
            createForumTopic: vi.fn(),
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.notifyCandidate(api as any, "cand-1");

        expect(result).toBe(onboardingCase);
        expect(api.sendMessage).not.toHaveBeenCalledWith(123, "notifyCandidate", expect.anything());
        expect(firstShiftOnboardingRepository.claimEntryMessageDelivery).not.toHaveBeenCalled();
        expect(firstShiftOnboardingRepository.markEntryMessageDelivered).not.toHaveBeenCalled();
    });

    it("claims and records entry delivery only once for open cases resumed from /start", async () => {
        vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue({
            id: "cand-1",
        } as any);

        const openCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "OPEN",
            topicId: 137,
            chatId: BigInt(-1001234567890),
            entryMessageSentAt: null,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n, firstName: "Вікторія", username: "vvvbach" },
                fullName: "Бачук Вікторія Вікторівна",
                location: { name: "Karamel" },
                city: "Коломия",
                firstShiftDate: new Date("2026-05-05T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                firstShiftPartner: null,
            },
            steps: [],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue(openCase);
        vi.mocked(firstShiftOnboardingRepository.findCaseByCandidateId).mockResolvedValue(openCase);
        vi.mocked(firstShiftOnboardingRepository.claimEntryMessageDelivery).mockResolvedValue(true);
        vi.mocked(firstShiftOnboardingRepository.markEntryMessageDelivered).mockResolvedValue({
            ...openCase,
            entryMessageSentAt: new Date("2026-05-05T10:01:00.000Z"),
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.resumeCandidateFlowFromStart(api as any, 123);

        expect(result).toBe(true);
        expect(firstShiftOnboardingRepository.claimEntryMessageDelivery).toHaveBeenCalledTimes(1);
        expect(firstShiftOnboardingRepository.markEntryMessageDelivered).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledWith(123, "notifyCandidate", expect.any(Object));
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

    it("pauses after the opening checklist instead of auto-opening stale closing steps", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-07T09:17:00.000Z"));

        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "export_test",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n, firstName: "Надія", username: "honijx54" },
                fullName: "Шмагай Надія Олександрівна",
                location: null,
                city: "Київ",
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-export",
                    key: "export_test",
                    order: 12,
                    block: "Photoshop + макети",
                    title: "Тестовий експорт",
                    prompt: "Надішли лінк.",
                    status: "SUBMITTED",
                    inputType: "LINK",
                    requiresMentorApproval: true,
                },
                {
                    id: "step-closing",
                    key: "closing_printer",
                    order: 13,
                    block: "Закриття зміни",
                    title: "Закрити принтер",
                    prompt: "Надішли фото принтера.",
                    status: "LOCKED",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                },
            ],
        } as any;
        const pausedCase = {
            ...onboardingCase,
            currentStepKey: null,
            status: "IN_PROGRESS",
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingStep.findUnique).mockResolvedValue({
            id: "step-export",
            caseId: "case-1",
        });
        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue({
            id: "case-1",
            candidateId: "cand-1",
        });
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue(onboardingCase);
        vi.mocked(firstShiftOnboardingRepository.updateCase).mockResolvedValue(pausedCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
        };

        const result = await firstShiftOnboardingService.approveStep(api as any, "step-export", 111);

        expect(result).toBe(pausedCase);
        expect(firstShiftOnboardingRepository.updateStep).toHaveBeenCalledWith("step-export", expect.objectContaining({
            status: "APPROVED",
        }));
        expect(firstShiftOnboardingRepository.updateStep).not.toHaveBeenCalledWith("step-closing", { status: "ACTIVE" });
        expect(firstShiftOnboardingRepository.updateCase).toHaveBeenCalledWith("case-1", {
            status: "IN_PROGRESS",
            currentStepKey: null,
        });
        expect(api.sendMessage).toHaveBeenCalledWith(123, "setupCompleted", expect.any(Object));
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

    it("auto-opens closing near shift end even when a pre-closing step is still submitted", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-01T16:30:00.000Z"));

        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "export_test",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n, firstName: "Вікторія", username: "vikixxzi" },
                fullName: "Попик Вікторія Русланівна",
                location: null,
                city: "Київ",
                firstShiftDate: new Date("2026-05-01T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-export",
                    key: "export_test",
                    order: 12,
                    block: "Photoshop + макети",
                    title: "Тестовий експорт",
                    prompt: "Надішли лінк.",
                    status: "SUBMITTED",
                    inputType: "LINK",
                    requiresMentorApproval: true,
                },
                {
                    id: "step-closing",
                    key: "closing_printer",
                    order: 13,
                    block: "Закриття зміни",
                    title: "Закрити принтер",
                    prompt: "Надішли фото принтера.",
                    status: "LOCKED",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                },
            ],
        } as any;
        const closingCase = {
            ...onboardingCase,
            currentStepKey: "closing_printer",
            status: "CLOSING",
            steps: [
                { ...onboardingCase.steps[0], status: "SKIPPED" },
                { ...onboardingCase.steps[1], status: "ACTIVE" },
            ],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingCase.findMany).mockResolvedValue([onboardingCase]);
        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue(onboardingCase);
        vi.mocked(firstShiftOnboardingRepository.updateStep).mockResolvedValue({} as any);
        vi.mocked(firstShiftOnboardingRepository.updateCase).mockResolvedValue(closingCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
        };

        await firstShiftOnboardingService.autoOpenUpcomingCases({ api } as any);

        expect((prisma as any).firstShiftOnboardingStep.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                caseId: "case-1",
                order: { lt: 13 },
                block: { not: "Закриття зміни" },
                status: { in: ["ACTIVE", "SUBMITTED", "REJECTED", "LOCKED"] },
            }),
            data: expect.objectContaining({
                status: "SKIPPED",
            }),
        }));
        expect((prisma as any).firstShiftOnboardingStep.updateMany).toHaveBeenCalledWith({
            where: { id: "step-closing", status: "LOCKED" },
            data: { status: "ACTIVE" },
        });
        expect(firstShiftOnboardingRepository.updateCase).toHaveBeenCalledWith("case-1", {
            status: "CLOSING",
            currentStepKey: "closing_printer",
        });
        expect(api.sendMessage).toHaveBeenCalledWith(123, "closingOpened", expect.any(Object));
    });

    it("does not reopen closing or resend prompts when closing is already active", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "CLOSING",
            currentStepKey: "closing_printer",
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
                    id: "step-closing",
                    key: "closing_printer",
                    order: 13,
                    block: "Закриття зміни",
                    title: "Закрити принтер",
                    prompt: "Надішли фото принтера.",
                    status: "ACTIVE",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                },
            ],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue(onboardingCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.openClosing(api as any, "case-1");

        expect(result).toBe(onboardingCase);
        expect((prisma as any).firstShiftOnboardingStep.updateMany).not.toHaveBeenCalled();
        expect(firstShiftOnboardingRepository.updateCase).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not reopen closing or reset a submitted closing step", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "CLOSING",
            currentStepKey: "closing_printer",
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
                    id: "step-closing",
                    key: "closing_printer",
                    order: 13,
                    block: "Закриття зміни",
                    title: "Закрити принтер",
                    prompt: "Надішли фото принтера.",
                    status: "SUBMITTED",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                    photoIds: "photo-file-id",
                },
            ],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue(onboardingCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.openClosing(api as any, "case-1");

        expect(result).toBe(onboardingCase);
        expect((prisma as any).firstShiftOnboardingStep.updateMany).not.toHaveBeenCalled();
        expect(firstShiftOnboardingRepository.updateCase).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("does not send duplicate closing notifications when another worker already claimed the opening step", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
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
            steps: [
                {
                    id: "step-closing",
                    key: "closing_printer",
                    order: 13,
                    block: "Закриття зміни",
                    title: "Закрити принтер",
                    prompt: "Надішли фото принтера.",
                    status: "LOCKED",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                },
            ],
        } as any;
        const refreshedCase = {
            ...onboardingCase,
            status: "CLOSING",
            currentStepKey: "closing_printer",
            steps: [{ ...onboardingCase.steps[0], status: "ACTIVE" }],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue(onboardingCase);
        vi.mocked((prisma as any).firstShiftOnboardingStep.updateMany).mockResolvedValue({ count: 0 });
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue(refreshedCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.openClosing(api as any, "case-1");

        expect(result).toBe(refreshedCase);
        expect(firstShiftOnboardingRepository.updateCase).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
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

    it("refreshes the pinned status card and exposes mentor buttons after a photo step is submitted", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);

        const initialCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "CLOSING",
            currentStepKey: "closing_printer",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            statusMessageId: 777,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n, firstName: "Надія", username: "honijx54" },
                fullName: "Шмагай Надія Олександрівна",
                location: { name: "Dytyache Horyshche" },
                city: "Київ",
                firstShiftDate: new Date("2026-05-05T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-13",
                    key: "closing_printer",
                    order: 13,
                    block: "Закриття зміни",
                    title: "Закрити принтер",
                    prompt: "Вимкни принтер кнопкою, вийми папір і закрий всі слоти. Надішли фото принтера.",
                    status: "ACTIVE",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                    updatedAt: new Date("2026-05-05T16:31:00.000Z"),
                },
            ],
        } as any;

        const submittedCase = {
            ...initialCase,
            steps: [
                {
                    ...initialCase.steps[0],
                    status: "SUBMITTED",
                    submittedAt: new Date("2026-05-05T16:33:00.000Z"),
                    updatedAt: new Date("2026-05-05T16:33:00.000Z"),
                },
            ],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId)
            .mockResolvedValueOnce(initialCase)
            .mockResolvedValueOnce(submittedCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            copyMessage: vi.fn().mockResolvedValue({}),
            editMessageText: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            photoId: "photo-file-id",
            messageId: 99,
            chatId: 123,
            hasCopyableOriginal: true,
        });

        expect(handled).toBe(true);
        expect(firstShiftOnboardingRepository.updateStep).toHaveBeenCalledWith("step-13", expect.objectContaining({
            status: "SUBMITTED",
        }));
        expect(api.editMessageText).toHaveBeenCalledWith(
            -1001234567890,
            777,
            expect.stringContaining("Стан:</b> 👀 Очікує ментора"),
            expect.objectContaining({
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
        expect(api.copyMessage).toHaveBeenCalledWith(
            -1001234567890,
            123,
            99,
            expect.objectContaining({
                message_thread_id: 42,
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
    });

    it("treats candidate media on approval button steps as a mentor-review submission", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);

        const activeCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "camera_import_test",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            statusMessageId: 777,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-import",
                    key: "camera_import_test",
                    order: 7,
                    block: "Камера",
                    title: "Тестовий імпорт",
                    prompt: "Зроби тестовий знімок і скинь фото.",
                    status: "ACTIVE",
                    inputType: "BUTTON",
                    requiresMentorApproval: true,
                    updatedAt: new Date("2026-05-05T12:00:00.000Z"),
                },
            ],
        } as any;
        const submittedCase = {
            ...activeCase,
            steps: [{ ...activeCase.steps[0], status: "SUBMITTED" }],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId)
            .mockResolvedValueOnce(activeCase)
            .mockResolvedValueOnce(submittedCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            copyMessage: vi.fn().mockResolvedValue({}),
            editMessageText: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            photoId: "photo-file-id",
            messageId: 99,
            chatId: 123,
            hasCopyableOriginal: true,
        });

        expect(handled).toBe(true);
        expect(firstShiftOnboardingRepository.updateStep).toHaveBeenCalledWith("step-import", expect.objectContaining({
            status: "SUBMITTED",
        }));
        expect(api.copyMessage).toHaveBeenCalledWith(
            -1001234567890,
            123,
            99,
            expect.objectContaining({
                message_thread_id: 42,
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
        expect(api.editMessageText).toHaveBeenCalledWith(
            -1001234567890,
            777,
            expect.stringContaining("Стан:</b> 👀 Очікує ментора"),
            expect.objectContaining({
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
        expect(api.sendMessage).toHaveBeenCalledWith(123, "submitted", expect.any(Object));
    });

    it("copies each multiple-photo upload without sending a mentor review card per photo", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);

        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "drawers_order",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            statusMessageId: 777,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-drawers",
                    key: "drawers_order",
                    order: 3,
                    block: "Стійка",
                    title: "Порядок у шухлядах",
                    prompt: "Надішли фото кожної шухляди.",
                    status: "ACTIVE",
                    inputType: "MULTIPLE_PHOTOS",
                    requiresMentorApproval: true,
                    photoIds: null,
                },
            ],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId)
            .mockResolvedValueOnce(onboardingCase)
            .mockResolvedValueOnce({
                ...onboardingCase,
                steps: [{ ...onboardingCase.steps[0], photoIds: "photo-file-id" }],
            } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            copyMessage: vi.fn().mockResolvedValue({}),
            editMessageText: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            photoId: "photo-file-id",
            messageId: 99,
            chatId: 123,
            hasCopyableOriginal: true,
        });

        expect(handled).toBe(true);
        expect(api.copyMessage).toHaveBeenCalledWith(
            -1001234567890,
            123,
            99,
            expect.objectContaining({ message_thread_id: 42 })
        );
        expect(api.copyMessage.mock.calls[0]?.[3]).not.toHaveProperty("reply_markup");
        expect(api.editMessageText).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalledWith(
            -1001234567890,
            expect.stringContaining("Крок:"),
            expect.any(Object)
        );
        expect(api.sendMessage).toHaveBeenCalledWith(
            123,
            "multiplePhotosHint",
            expect.any(Object)
        );
    });

    it("turns mentor-observed candidate messages into mentor review actions", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);

        const activeCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "photoshop_practice",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            statusMessageId: 777,
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n },
                location: null,
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-photoshop",
                    key: "photoshop_practice",
                    order: 11,
                    block: "Photoshop + макети",
                    title: "Практика в макетах",
                    prompt: "Перевірити через віддалений доступ.",
                    status: "ACTIVE",
                    inputType: "MENTOR_OBSERVED",
                    requiresMentorApproval: true,
                    updatedAt: new Date("2026-05-05T12:00:00.000Z"),
                },
            ],
        } as any;
        const submittedCase = {
            ...activeCase,
            steps: [{ ...activeCase.steps[0], status: "SUBMITTED", submittedText: "Зробила" }],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId)
            .mockResolvedValueOnce(activeCase)
            .mockResolvedValueOnce(submittedCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            editMessageText: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            text: "Зробила",
            messageId: 99,
            chatId: 123,
        });

        expect(handled).toBe(true);
        expect(firstShiftOnboardingRepository.updateStep).toHaveBeenCalledWith("step-photoshop", expect.objectContaining({
            status: "SUBMITTED",
            submittedText: "Зробила",
        }));
        expect(api.sendMessage).toHaveBeenCalledWith(
            -1001234567890,
            expect.stringContaining("Зробила"),
            expect.objectContaining({
                message_thread_id: 42,
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
        expect(api.editMessageText).toHaveBeenCalledWith(
            -1001234567890,
            777,
            expect.stringContaining("Стан:</b> 👀 Очікує ментора"),
            expect.objectContaining({
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
        expect(api.sendMessage).toHaveBeenCalledWith(123, "submitted", expect.any(Object));
    });

    it("forwards voice or video-note messages to the onboarding topic during a photo step", async () => {
        vi.mocked((prisma as any).candidate.findFirst).mockResolvedValue({
            id: "cand-1",
            user: { telegramId: 123n },
            location: null,
        } as any);
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue({
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "camera_settings",
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
                    id: "step-camera",
                    key: "camera_settings",
                    order: 4,
                    block: "Камера",
                    title: "Налаштування камери",
                    prompt: "Надішли фото головного екрану камери.",
                    status: "ACTIVE",
                    inputType: "PHOTO",
                    requiresMentorApproval: true,
                },
            ],
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            copyMessage: vi.fn().mockResolvedValue({}),
        };

        const handled = await firstShiftOnboardingService.handleCandidateMessage(api as any, 123, {
            messageId: 100,
            chatId: 123,
            hasCopyableOriginal: true,
        });

        expect(handled).toBe(true);
        expect(api.copyMessage).toHaveBeenCalledWith(
            -1001234567890,
            123,
            100,
            expect.objectContaining({ message_thread_id: 42 })
        );
        expect(api.sendMessage).toHaveBeenCalledWith(123, "questionForwarded", expect.any(Object));
        expect(api.sendMessage).not.toHaveBeenCalledWith(123, "sendPhotoExpected", expect.any(Object));
    });

    it("adds review buttons to text submissions that wait for mentor approval", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "IN_PROGRESS",
            currentStepKey: "export_test",
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
                    id: "step-link",
                    key: "export_test",
                    order: 12,
                    block: "Photoshop + макети",
                    title: "Тестовий експорт",
                    prompt: "Надішли лінк.",
                    status: "ACTIVE",
                    inputType: "LINK",
                    requiresMentorApproval: true,
                },
            ],
        } as any;

        vi.mocked(firstShiftOnboardingRepository.updateStep).mockResolvedValue({
            ...onboardingCase.steps[0],
            status: "SUBMITTED",
        } as any);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
        };

        await (firstShiftOnboardingService as any).submitStep(api as any, onboardingCase, onboardingCase.steps[0], {
            text: "https://example.com/export",
        });

        expect(api.sendMessage).toHaveBeenCalledWith(
            -1001234567890,
            expect.stringContaining("https://example.com/export"),
            expect.objectContaining({
                message_thread_id: 42,
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Підтвердити", "🔁 На переробку"]),
                }),
            })
        );
    });

    it("shows final decision buttons after approving the last onboarding step", async () => {
        const onboardingCase = {
            id: "case-1",
            candidateId: "cand-1",
            status: "CLOSING",
            currentStepKey: "finish_script",
            chatId: BigInt(-1001234567890),
            topicId: 42,
            statusMessageId: 777,
            createdAt: new Date("2026-05-05T09:00:00.000Z"),
            updatedAt: new Date("2026-05-05T18:00:00.000Z"),
            candidate: {
                id: "cand-1",
                userId: "user-1",
                user: { telegramId: 123n, firstName: "Надія", username: "honijx54" },
                fullName: "Шмагай Надія Олександрівна",
                location: { name: "Dytyache Horyshche" },
                city: "Київ",
                firstShiftDate: new Date("2026-05-05T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                firstShiftPartner: null,
            },
            steps: [
                {
                    id: "step-finish",
                    key: "finish_script",
                    order: 19,
                    block: "Закриття зміни",
                    title: "FINISH",
                    prompt: "Запусти скрипт FINISH.",
                    status: "SUBMITTED",
                    inputType: "BUTTON",
                    requiresMentorApproval: true,
                    submittedAt: new Date("2026-05-05T18:00:00.000Z"),
                    updatedAt: new Date("2026-05-05T18:00:00.000Z"),
                },
            ],
        } as any;
        const pendingCase = {
            ...onboardingCase,
            status: "PENDING_FINAL",
            currentStepKey: null,
            steps: [{ ...onboardingCase.steps[0], status: "APPROVED" }],
        } as any;

        vi.mocked((prisma as any).firstShiftOnboardingStep.findUnique).mockResolvedValue({
            id: "step-finish",
            caseId: "case-1",
        });
        vi.mocked((prisma as any).firstShiftOnboardingCase.findUnique).mockResolvedValue({
            id: "case-1",
            candidateId: "cand-1",
        });
        vi.mocked(firstShiftOnboardingRepository.findActiveCaseByCandidateId).mockResolvedValue(onboardingCase);
        vi.mocked(firstShiftOnboardingRepository.updateCase).mockResolvedValue(pendingCase);

        const api = {
            sendMessage: vi.fn().mockResolvedValue({}),
            editMessageText: vi.fn().mockResolvedValue({}),
        };

        const result = await firstShiftOnboardingService.approveStep(api as any, "step-finish", 111);

        expect(result).toBe(pendingCase);
        expect(api.sendMessage).toHaveBeenCalledWith(
            -1001234567890,
            expect.stringContaining("Дія ментора"),
            expect.objectContaining({
                message_thread_id: 42,
                reply_markup: expect.objectContaining({
                    buttons: expect.arrayContaining(["✅ Завершити успішно", "❌ Не пройшла"]),
                }),
            })
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

        expect(keyboard.buttons).toContain("✅ Підтвердити");
        expect(keyboard.buttons).toContain("🔁 На переробку");
        expect(keyboard.buttons).not.toContain("✅ Завершити успішно");
        expect(keyboard.buttons).not.toContain("❌ Не пройшла");
    });

    it("builds a compact mentor status card", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-05T12:30:00.000Z"));

        const text = (firstShiftOnboardingService as any).buildStatusCard({
            id: "case-1",
            status: "IN_PROGRESS",
            createdAt: new Date("2026-05-05T09:00:00.000Z"),
            updatedAt: new Date("2026-05-05T12:20:00.000Z"),
            candidate: {
                fullName: "Бачук Вікторія",
                city: "Коломия",
                firstShiftDate: new Date("2026-05-05T00:00:00.000Z"),
                firstShiftTime: "14:00-20:00",
                location: { name: "Karamel" },
                user: { firstName: "Вікторія", username: "vvvbach" },
                firstShiftPartner: { fullName: "Марія Коваль", user: { firstName: "Марія", username: "mentor_maria" } },
            },
            steps: [
                {
                    id: "step-1",
                    key: "laptop_start",
                    order: 1,
                    block: "Ноутбук",
                    title: "Підготувати ноутбук",
                    prompt: "Надішли скрін робочого столу.",
                    status: "APPROVED",
                    inputType: "SCREENSHOT",
                    approvedAt: new Date("2026-05-05T11:50:00.000Z"),
                    completedAt: new Date("2026-05-05T11:50:00.000Z"),
                    updatedAt: new Date("2026-05-05T11:50:00.000Z"),
                },
                {
                    id: "step-2",
                    key: "camera_settings",
                    order: 2,
                    block: "Камера",
                    title: "Налаштування камери",
                    prompt: "Надішли фото екрану камери.",
                    status: "SUBMITTED",
                    inputType: "PHOTO",
                    submittedAt: new Date("2026-05-05T12:10:00.000Z"),
                    updatedAt: new Date("2026-05-05T12:10:00.000Z"),
                },
            ],
        });

        expect(text).toContain("Стан:</b> 👀 Очікує ментора");
        expect(text).toContain("Зараз:</b> 2/2 · Налаштування камери");
        expect(text).toContain("Що робить фотограф:</b> Надішли фото екрану камери.");
        expect(text).toContain("Дія ментора:</b> Перевірити виконання і натиснути Підтвердити або На переробку.");
        expect(text).toContain("Очікує:</b> 20 хв");
    });
});
