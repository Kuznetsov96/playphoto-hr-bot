import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CANDIDATE_TEXTS } from "../../constants/candidate-texts.js";

const cancelInterviewSlot = vi.fn().mockResolvedValue(undefined);
const cancelTrainingSlot = vi.fn().mockResolvedValue(undefined);
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
        // Кнопки запам'ятовуються: екран підтвердження перевіряється за складом.
        buttons: Array<{ label: string; data: string }> = [];
        text(label: string, data: string) { this.buttons.push({ label, data }); return this; }
        row() { return this; }
        // grammy 1.45 має .danger() — стиль червоної кнопки. Мок без нього
        // падав би на будь-якому підтвердженні руйнівної дії.
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
    // Флаг канонических слотов обязан присутствовать в моке: vitest падает на
    // чтении несуществующего экспорта, а путь отмены теперь его читает.
    AWS_RECRUITING_SLOTS_ENABLED: false,
}));

vi.mock("../../services/booking-service.js", () => ({
    bookingService: {
        cancelInterviewSlot,
        cancelTrainingSlot,
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

// staff-texts більше не мокається: підтвердження відмови переїхало до
// CANDIDATE_TEXTS. Перевіряємо справжній рядок — саме він поїде людині.

describe("booking decline invite", () => {
    let bookingHandlers: any;
    let buildSignedCallback: (code: string, payload: string) => string;

    beforeAll(async () => {
        ({ bookingHandlers } = await import("../booking.js"));
        ({ buildSignedCallback } = await import("../../utils/signed-callback.js"));
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("asks for confirmation first instead of rejecting on the first tap", async () => {
        const ctx = {
            from: { id: 123456 },
            callbackQuery: { data: "decline_invite" },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback("decline_invite", ctx);

        // Кнопка стоїть просто під «Обрати час», а дія незворотна — перший
        // тап зобов'язаний лише питати.
        expect(updateMany).not.toHaveBeenCalled();
        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(ctx.editMessageText).toHaveBeenCalledWith(
            CANDIDATE_TEXTS["candidate-decline-invite-confirm"],
            expect.objectContaining({ parse_mode: "HTML" }),
        );
    });

    it("на підтвердженні відмови є вихід «не бачу зручного часу»", async () => {
        const ctx = {
            from: { id: 123457 },
            callbackQuery: { data: "decline_invite" },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback("decline_invite", ctx);

        // 30.09.2026 кандидатка, якій не підходив час, натиснула «Так,
        // завершити заявку», а через 5 секунд — «Не бачу зручного часу».
        // Текст радив «поверніться й оберіть інший», але кнопки не давав.
        const buttons = ctx.editMessageText.mock.calls[0]![1].reply_markup.buttons as Array<{ label: string; data: string }>;
        expect(buttons.map((b) => b.data)).toContain("no_slots_fit");
        // Руйнівна кнопка — остання: після редагування на місці «Обрати час»
        // не має опинитися «Так, завершити заявку».
        expect(buttons.at(-1)!.data).toBe("decline_invite_confirm");
    });

    it("cancels existing interview slot and clears candidate state", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1",
            fullName: "Jane",
            interviewSlotId: "slot-1",
        });

        const ctx = {
            from: { id: 123456 },
            callbackQuery: { data: "decline_invite_confirm" },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback("decline_invite_confirm", ctx);

        expect(cancelInterviewSlot).toHaveBeenCalledWith("slot-1", 123456);
        expect(updateMany).toHaveBeenCalledWith(
            { user: { telegramId: BigInt(123456) } },
            expect.objectContaining({
                status: "REJECTED",
                candidateDecision: "Відмова кандидата (не актуально)",
                googleMeetLink: null,
            })
        );
        // Відмовилась сама — у вебаппі це не має виглядати рішенням HR (B9).
        expect(updateMany.mock.calls[0]![1]).not.toHaveProperty("hrDecision");
        expect(ctx.editMessageText).toHaveBeenCalledWith(
            CANDIDATE_TEXTS["candidate-interview-invitation-declined"],
        );
        // Тон відмови: на «ви» і без емодзі — інваріант усієї воронки.
        const declineText = ctx.editMessageText.mock.calls[0]![0] as string;
        expect(declineText).not.toMatch(/\bти\b|\bтобі\b|\bтебе\b/i);
        expect(declineText).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("does not attempt slot cleanup when candidate has no interview slot", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-2",
            fullName: "Jane",
            interviewSlotId: null,
        });

        const ctx = {
            from: { id: 987654 },
            callbackQuery: { data: "decline_invite_confirm" },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback("decline_invite_confirm", ctx);

        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalledWith(
            { user: { telegramId: BigInt(987654) } },
            expect.objectContaining({
                status: "REJECTED",
            })
        );
    });

    it("cancels an interview booking without rejecting the candidate", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-cancel",
            fullName: "Jane",
            status: "INTERVIEW_SCHEDULED",
            interviewSlotId: "slot-cancel",
        });

        const ctx = {
            from: { id: 111222 },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback(buildSignedCallback("ccb", "slot-cancel"), ctx);

        expect(cancelInterviewSlot).toHaveBeenCalledWith("slot-cancel", 111222);
        expect(update).toHaveBeenCalledWith(
            "cand-cancel",
            expect.objectContaining({
                status: "WAITLIST_HR",
                currentStep: "INTERVIEW",
                isWaitlisted: true,
                candidateDecision: null,
                notificationSent: false,
                googleMeetLink: null,
            })
        );
        expect(update).not.toHaveBeenCalledWith(
            "cand-cancel",
            expect.objectContaining({ status: "REJECTED" })
        );
    });

    it("rejects only after explicit vacancy withdrawal confirmation", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-withdraw",
            fullName: "Jane",
            status: "INTERVIEW_SCHEDULED",
            interviewSlotId: "slot-withdraw",
        });

        const ctx = {
            from: { id: 333444 },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback(buildSignedCallback("cwi", "slot-withdraw"), ctx);

        expect(cancelInterviewSlot).toHaveBeenCalledWith("slot-withdraw", 333444);
        expect(update).toHaveBeenCalledWith(
            "cand-withdraw",
            expect.objectContaining({
                status: "REJECTED",
                candidateDecision: "Кандидатка відмовилась від вакансії",
                notificationSent: true,
                googleMeetLink: null,
            })
        );
    });

    it("старая кнопка отмены после интервью не возвращает кандидатку в очередь", async () => {
        // Слот остаётся привязанным после автозавершения интервью; без проверки
        // статуса кнопка из подтверждения брони переводила кандидатку с решением
        // HR в WAITLIST_HR, и оффер или отказ ей уже не уходил.
        findByTelegramId.mockResolvedValue({
            id: "cand-done",
            fullName: "Jane",
            status: "INTERVIEW_COMPLETED",
            interviewSlotId: "slot-done",
        });

        const ctx = {
            from: { id: 555666 },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback(buildSignedCallback("ccb", "slot-done"), ctx);

        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Цей запис уже неактуальний");
    });

    // Аудит 01.10.2026: запис на знайомство/навчання прибрано. Старі кнопки
    // в чатах лишилися — тап має лише відповісти й показати статус.
    it.each([
        ["cct", "training-slot-cancel"],
        ["cwm", "discovery-slot-withdraw"],
        ["rt", "training-slot-reschedule"],
        ["cstg", "cand-staging"],
    ])("стара кнопка %s етапу наставника нічого не змінює", async (code, payload) => {
        findByTelegramId.mockResolvedValue({
            id: "cand-hired",
            fullName: "Jane",
            status: "HIRED",
            trainingSlotId: payload,
        });

        const ctx = {
            from: { id: 555666 },
            answerCallbackQuery: vi.fn(),
            editMessageText: vi.fn(),
            api: { sendMessage: vi.fn() },
        };

        await bookingHandlers.__runCallback(buildSignedCallback(code, payload), ctx);

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Цей запис уже неактуальний");
        expect(cancelTrainingSlot).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });

    it.each(["start_training_scheduling", "training_no_slots_fit", "book_training_slot_abc", "training_date_header_1"])(
        "стара кнопка запису на навчання %s не переводить у WAITLIST_MENTOR",
        async (data) => {
            findByTelegramId.mockResolvedValue({ id: "cand-screening", status: "SCREENING" });
            const ctx = {
                from: { id: 555667 },
                answerCallbackQuery: vi.fn(),
                editMessageText: vi.fn(),
                api: { sendMessage: vi.fn() },
            };

            await bookingHandlers.__runCallback(data, ctx);

            expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
            expect(update).not.toHaveBeenCalled();
            expect(updateMany).not.toHaveBeenCalled();
        },
    );
});
