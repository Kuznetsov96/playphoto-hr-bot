import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cancelInterviewSlot = vi.fn().mockResolvedValue(undefined);
const findByTelegramId = vi.fn();
const updateMany = vi.fn();

vi.mock("grammy", () => {
    class MockComposer {
        private callbackHandlers: Array<{ pattern: string | RegExp; handler: (ctx: any) => Promise<void> | void }> = [];

        callbackQuery(pattern: string | RegExp, handler: (ctx: any) => Promise<void> | void) {
            this.callbackHandlers.push({ pattern, handler });
            return this;
        }

        on() {
            return this;
        }

        async __runCallback(data: string, ctx: any) {
            for (const entry of this.callbackHandlers) {
                if (typeof entry.pattern === "string" && entry.pattern === data) {
                    await entry.handler(ctx);
                    return;
                }
                if (entry.pattern instanceof RegExp && entry.pattern.test(data)) {
                    await entry.handler(ctx);
                    return;
                }
            }
            throw new Error(`No callback handler matched: ${data}`);
        }
    }

    class MockInlineKeyboard {
        text() { return this; }
        row() { return this; }
    }

    return {
        Bot: class { },
        Composer: MockComposer,
        InlineKeyboard: MockInlineKeyboard,
    };
});

vi.mock("../../config.js", () => ({
    ADMIN_IDS: [],
    HR_IDS: [],
    MENTOR_IDS: [],
    HR_NAME: "HR",
    MENTOR_NAME: "Mentor",
}));

vi.mock("../../services/booking-service.js", () => ({
    bookingService: {
        cancelInterviewSlot,
        cancelTrainingSlot: vi.fn(),
        bookInterviewSlot: vi.fn(),
        bookTrainingSlot: vi.fn(),
    }
}));

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findByTelegramId,
        updateMany,
        update: vi.fn(),
    }
}));

vi.mock("../../repositories/interview-repository.js", () => ({
    interviewRepository: {
        findActiveSlots: vi.fn(),
    }
}));

vi.mock("../../repositories/training-repository.js", () => ({
    trainingRepository: {
        findActiveSlots: vi.fn(),
    }
}));

vi.mock("../../services/google-calendar.js", () => ({
    googleCalendar: {}
}));

vi.mock("../../utils/cleanup.js", () => ({
    trackMessage: vi.fn(),
    cleanupMessages: vi.fn(),
}));

vi.mock("../../utils/candidate-age.js", () => ({
    getBirthDateRejection: vi.fn(() => null),
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }
}));

vi.mock("../../utils/screen-manager.js", () => ({
    ScreenManager: {
        renderScreen: vi.fn(),
    }
}));

vi.mock("../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "hr-info-invite-declined": "declined",
    }
}));

describe("booking decline invite", () => {
    let bookingHandlers: any;

    beforeAll(async () => {
        ({ bookingHandlers } = await import("../booking.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("cancels existing interview slot and clears candidate state", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1",
            fullName: "Jane",
            interviewSlotId: "slot-1",
        });

        const ctx = {
            from: { id: 123456 },
            callbackQuery: { data: "decline_invite" },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback("decline_invite", ctx);

        expect(cancelInterviewSlot).toHaveBeenCalledWith("slot-1", 123456);
        expect(updateMany).toHaveBeenCalledWith(
            { user: { telegramId: BigInt(123456) } },
            expect.objectContaining({
                status: "REJECTED",
                hrDecision: "REJECTED",
                googleMeetLink: null,
            })
        );
        expect(ctx.editMessageText).toHaveBeenCalledWith("declined");
    });

    it("does not attempt slot cleanup when candidate has no interview slot", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-2",
            fullName: "Jane",
            interviewSlotId: null,
        });

        const ctx = {
            from: { id: 987654 },
            callbackQuery: { data: "decline_invite" },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback("decline_invite", ctx);

        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalledWith(
            { user: { telegramId: BigInt(987654) } },
            expect.objectContaining({
                status: "REJECTED",
            })
        );
    });
});
