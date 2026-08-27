import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Кандидатский флоу интервью поверх канонических слотов вебаппа (фаза 2b).
 * Сервис canonical-interview-slots замокан целиком: здесь проверяется, что
 * хендлеры зовут именно его (а не bookingService/interviewRepository напрямую),
 * что вебапп освобождается ДО локальной отмены и что проигрыш гонки за слот
 * показывает кандидатке «слот занят» со свежим списком.
 */

const bookInterviewSlotFlow = vi.fn();
const findAvailableInterviewSlots = vi.fn();
const releaseCanonicalInterviewSlot = vi.fn();
const cancelInterviewSlot = vi.fn().mockResolvedValue(undefined);
const findByTelegramId = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();

vi.mock("grammy", () => {
    class MockComposer {
        private callbackHandlers: Array<{ pattern: string | RegExp; handler: (ctx: any) => Promise<void> | void }> = [];
        private onHandlers: Array<(ctx: any, next: () => Promise<void>) => Promise<void> | void> = [];

        callbackQuery(pattern: string | RegExp, handler: (ctx: any) => Promise<void> | void) {
            this.callbackHandlers.push({ pattern, handler });
            return this;
        }

        on(_filter: string, handler: (ctx: any, next: () => Promise<void>) => Promise<void> | void) {
            this.onHandlers.push(handler);
            return this;
        }

        async __runCallback(data: string, ctx: any) {
            ctx.callbackQuery = { ...(ctx.callbackQuery || {}), data };
            for (const entry of this.callbackHandlers) {
                if (typeof entry.pattern === "string" && entry.pattern === data) {
                    await entry.handler(ctx);
                    return;
                }
                if (entry.pattern instanceof RegExp && entry.pattern.test(data)) {
                    const match = data.match(entry.pattern);
                    ctx.match = match;
                    await entry.handler(ctx);
                    return;
                }
            }

            let index = -1;
            const runNext = async (): Promise<void> => {
                index++;
                const handler = this.onHandlers[index];
                if (!handler) throw new Error(`No callback handler matched: ${data}`);
                await handler(ctx, runNext);
            };

            await runNext();
        }
    }

    class MockInlineKeyboard {
        text() { return this; }
        row() { return this; }
        danger() { return this; }
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

vi.mock("../../services/canonical-interview-slots.js", () => ({
    bookInterviewSlot: bookInterviewSlotFlow,
    findAvailableInterviewSlots,
    releaseCanonicalInterviewSlot,
}));

vi.mock("../../services/aws-business-client.js", () => {
    class AwsBusinessApiError extends Error {
        constructor(
            public readonly status: number,
            public readonly code: string | undefined,
            message: string,
        ) {
            super(message);
            this.name = "AwsBusinessApiError";
        }
    }
    return { AwsBusinessApiError, RECRUITING_SLOT_TAKEN_CODE: "RECRUITING_SLOT_TAKEN" };
});

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
        update,
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

const WEB_SLOT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function makeCtx(telegramId: number) {
    return {
        from: { id: telegramId, username: "olena", first_name: "Олена" },
        callbackQuery: {},
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        editMessageText: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue({ message_id: 7 }),
        api: { sendMessage: vi.fn().mockResolvedValue(undefined) },
    };
}

describe("interview booking over canonical slots", () => {
    let bookingHandlers: any;
    let buildSignedCallback: (code: string, payload: string) => string;
    let AwsBusinessApiError: any;

    beforeAll(async () => {
        ({ bookingHandlers } = await import("../booking.js"));
        ({ buildSignedCallback } = await import("../../utils/signed-callback.js"));
        ({ AwsBusinessApiError } = await import("../../services/aws-business-client.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        cancelInterviewSlot.mockResolvedValue(undefined);
        releaseCanonicalInterviewSlot.mockResolvedValue(undefined);
    });

    it("start_scheduling lists slots through the canonical-or-local switch", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", status: "SCREENING", gender: "female" });
        findAvailableInterviewSlots.mockResolvedValue([
            { id: WEB_SLOT_ID, startTime: new Date("2026-09-01T10:00:00Z") },
        ]);

        const ctx = makeCtx(111001);
        await bookingHandlers.__runCallback("start_scheduling", ctx);

        expect(findAvailableInterviewSlots).toHaveBeenCalledTimes(1);
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining("Обери зручний час"),
            expect.anything(),
        );
    });

    it("book_slot_<uuid> books through the switch with the web slot publicId", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", userId: "user-1", interviewSlotId: null });
        bookInterviewSlotFlow.mockResolvedValue({
            slot: { id: "local-mirror-1", startTime: new Date("2026-09-01T10:00:00Z"), candidate: { fullName: "Олена Тест", userId: "user-1" } },
            googleEvent: { meetLink: "https://meet.example/abc", eventId: "ev-1" },
        });

        const ctx = makeCtx(111002);
        await bookingHandlers.__runCallback(`book_slot_${WEB_SLOT_ID}`, ctx);

        expect(bookInterviewSlotFlow).toHaveBeenCalledWith(111002, WEB_SLOT_ID, "olena");
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining("заброньовано"),
            expect.anything(),
        );
    });

    it("on RECRUITING_SLOT_TAKEN tells the candidate the slot is gone and refreshes the list", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", interviewSlotId: null });
        bookInterviewSlotFlow.mockRejectedValue(
            new AwsBusinessApiError(409, "RECRUITING_SLOT_TAKEN", "AWS business API request failed with HTTP 409"),
        );
        findAvailableInterviewSlots.mockResolvedValue([
            { id: "5e885ee1-6b91-45f2-b26c-679b2a3e1a10", startTime: new Date("2026-09-01T11:00:00Z") },
        ]);

        const ctx = makeCtx(111003);
        await bookingHandlers.__runCallback(`book_slot_${WEB_SLOT_ID}`, ctx);

        const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");
        expect(ctx.editMessageText).toHaveBeenCalledWith(
            CANDIDATE_TEXTS["candidate-interview-slot-taken"],
            expect.objectContaining({ reply_markup: expect.anything() }),
        );
        expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("cancel releases the canonical slot BEFORE the local cancel, reason candidate_cancelled", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена" });

        const ctx = makeCtx(111004);
        await bookingHandlers.__runCallback(buildSignedCallback("ccb", "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(111004, "candidate_cancelled");
        expect(cancelInterviewSlot).toHaveBeenCalledWith("local-slot-1", 111004);
        expect(releaseCanonicalInterviewSlot.mock.invocationCallOrder[0]!)
            .toBeLessThan(cancelInterviewSlot.mock.invocationCallOrder[0]!);
    });

    it("withdraw releases the canonical slot with reason candidate_withdrew", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена" });

        const ctx = makeCtx(111005);
        await bookingHandlers.__runCallback(buildSignedCallback("cwi", "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(111005, "candidate_withdrew");
        expect(cancelInterviewSlot).toHaveBeenCalledWith("local-slot-1", 111005);
    });

    it("reschedule releases the canonical slot with reason rescheduled and lists through the switch", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена" });
        findAvailableInterviewSlots.mockResolvedValue([
            { id: WEB_SLOT_ID, startTime: new Date("2026-09-02T10:00:00Z") },
        ]);

        const ctx = makeCtx(111006);
        await bookingHandlers.__runCallback(buildSignedCallback("rb", "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(111006, "rescheduled");
        expect(cancelInterviewSlot).toHaveBeenCalledWith("local-slot-1", 111006);
        expect(findAvailableInterviewSlots).toHaveBeenCalledTimes(1);
        expect(releaseCanonicalInterviewSlot.mock.invocationCallOrder[0]!)
            .toBeLessThan(cancelInterviewSlot.mock.invocationCallOrder[0]!);
    });

    it("a failed canonical release blocks the local cancel — the web slot must not stay taken silently", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена" });
        releaseCanonicalInterviewSlot.mockRejectedValue(new Error("HTTP 502"));

        const ctx = makeCtx(111007);
        await bookingHandlers.__runCallback(buildSignedCallback("ccb", "local-slot-1"), ctx);

        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Сталася помилка.");
    });
});
