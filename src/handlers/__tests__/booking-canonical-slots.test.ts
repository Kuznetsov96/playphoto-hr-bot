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
    return {
        AwsBusinessApiError,
        RECRUITING_SLOT_TAKEN_CODE: "RECRUITING_SLOT_TAKEN",
        awsBusinessClient: { pushIncomingRecruitingMessage: vi.fn().mockResolvedValue(undefined) },
    };
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

    it("гард: кнопки приглашения, сброшенного через 48 часов, больше не бронируют", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "WAITLIST_HR", gender: "female",
            currentStep: "INITIAL_TEST", notificationSent: false, interviewSlotId: null,
        });
        const ctx = makeCtx(111009);
        ctx.callbackQuery = { data: "start_scheduling" };
        const next = vi.fn();

        const guard = (bookingHandlers as any).onHandlers[0];
        await guard(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Запис зараз недоступний");
    });

    it("гард: приглашённая проходит к выбору времени", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "SCREENING", gender: "female",
            currentStep: "INITIAL_TEST", notificationSent: true, interviewSlotId: null,
        });
        const ctx = makeCtx(111010);
        ctx.callbackQuery = { data: "start_scheduling" };
        const next = vi.fn();

        await (bookingHandlers as any).onHandlers[0](ctx, next);

        expect(next).toHaveBeenCalled();
    });

    // 30.09.2026: кандидатка ждала новых окон, тапнула «Не планую продовжувати»
    // на напоминании суточной давности и закрыла себе заявку.
    it.each(["decline_invite", "decline_invite_confirm"])(
        "гард: %s со старого напоминания у ждущей окна не проходит",
        async (data) => {
            findByTelegramId.mockResolvedValue({
                id: "cand-1", status: "SCREENING", gender: "female",
                currentStep: "INTERVIEW", notificationSent: true,
                interviewInvitedAt: null, interviewSlotId: null,
            });
            const ctx = makeCtx(111020);
            ctx.callbackQuery = { data };
            const next = vi.fn();

            await (bookingHandlers as any).onHandlers[0](ctx, next);

            expect(next).not.toHaveBeenCalled();
            expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Це запрошення вже неактуальне");
        },
    );

    it("гард: отказ из действующего приглашения проходит", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "SCREENING", gender: "female",
            currentStep: "INITIAL_TEST", notificationSent: true,
            interviewInvitedAt: new Date(), interviewSlotId: null,
        });
        const ctx = makeCtx(111021);
        ctx.callbackQuery = { data: "decline_invite_confirm" };
        const next = vi.fn();

        await (bookingHandlers as any).onHandlers[0](ctx, next);

        expect(next).toHaveBeenCalled();
    });

    // Там же через 5 секунд: «Не бачу зручного часу» у уже отклонённой падал
    // на запрете перехода REJECTED → SCREENING и показывал «Ой, щось пішло не так».
    it("гард: «не бачу зручного часу» у отклонённой показывает статус, а не падает", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "REJECTED", gender: "female",
            currentStep: "INTERVIEW", notificationSent: true, interviewSlotId: null,
        });
        const ctx = makeCtx(111022);
        ctx.callbackQuery = { data: "no_slots_fit" };
        const next = vi.fn();

        await (bookingHandlers as any).onHandlers[0](ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("«не підходить час» теж ставить noSlotsAt — рекрутёр видит её в секции «потребує вікон»", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", status: "SCREENING", gender: "female" });
        updateMany.mockResolvedValue({ count: 1 });
        const { interviewRepository } = await import("../../repositories/interview-repository.js");
        vi.mocked(interviewRepository.findActiveSlots).mockResolvedValue([] as any);

        const ctx = makeCtx(111011);
        await bookingHandlers.__runCallback("no_slots_fit", ctx);

        expect(updateMany).toHaveBeenCalledWith(
            { user: { telegramId: 111011n } },
            expect.objectContaining({
                interviewWaitlistReason: "NO_DATE_FITS",
                noSlotsAt: expect.any(Date),
                interviewWaitlistedAt: expect.any(Date),
            }),
        );
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
            expect.stringContaining("Оберіть зручний час"),
            expect.anything(),
        );
    });

    it("start_scheduling with no active slots stamps noSlotsAt for the web inbox and sends no HR telegram alert", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", status: "SCREENING", gender: "female", fullName: "Олена Тест" });
        findAvailableInterviewSlots.mockResolvedValue([]);
        updateMany.mockResolvedValue({ count: 1 });

        const ctx = makeCtx(111008);
        await bookingHandlers.__runCallback("start_scheduling", ctx);

        expect(updateMany).toHaveBeenCalledWith(
            { user: { telegramId: 111008n } },
            expect.objectContaining({ noSlotsAt: expect.any(Date) }),
        );
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining("Графік співбесід зараз оновлюється"),
            expect.anything(),
        );
        // Раньше здесь дублировался телеграм-алерт HR — теперь сигнал уходит
        // только через noSlotsAt в зеркало, живого HR_IDS[0] в моке нет вовсе.
        expect(ctx.api.sendMessage).not.toHaveBeenCalled();
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

    it("unknown booking failure says what failed — not a bare «Сталася помилка»", async () => {
        // Аудит 01.10.2026: спливаюче «Сталася помилка» не казало, що саме не
        // вийшло і що робити далі.
        findByTelegramId.mockResolvedValue({ id: "cand-1", interviewSlotId: null });
        bookInterviewSlotFlow.mockRejectedValue(new Error("HTTP 502"));

        const ctx = makeCtx(111035);
        await bookingHandlers.__runCallback(`book_slot_${WEB_SLOT_ID}`, ctx);

        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Не вдалося записати. Спробуйте ще раз");
    });

    it("cancel releases the canonical slot BEFORE the local cancel, reason candidate_cancelled", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена", status: "INTERVIEW_SCHEDULED", interviewSlotId: "local-slot-1" });

        const ctx = makeCtx(111004);
        await bookingHandlers.__runCallback(buildSignedCallback("ccb", "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(111004, "candidate_cancelled");
        expect(cancelInterviewSlot).toHaveBeenCalledWith("local-slot-1", 111004);
        expect(releaseCanonicalInterviewSlot.mock.invocationCallOrder[0]!)
            .toBeLessThan(cancelInterviewSlot.mock.invocationCallOrder[0]!);
    });

    it("withdraw releases the canonical slot with reason candidate_withdrew", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена", status: "INTERVIEW_SCHEDULED", interviewSlotId: "local-slot-1" });

        const ctx = makeCtx(111005);
        await bookingHandlers.__runCallback(buildSignedCallback("cwi", "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(111005, "candidate_withdrew");
        expect(cancelInterviewSlot).toHaveBeenCalledWith("local-slot-1", 111005);
    });

    // 30.09.2026 дві кандидатки втратили запис однаково: «Змінити час» одразу
    // звільняв слот, а підходящого нового не знайшлося. Тепер перенос — обмін:
    // старий слот тримається, доки не обрано новий (вебапп book() міняє їх
    // однією транзакцією).
    it("перенос не звільняє поточний слот — лише показує інший час і «Лишити мій час»", async () => {
        const startsIn2h = new Date(Date.now() + 2 * 3600e3);
        findByTelegramId.mockResolvedValue({
            id: "cand-1", fullName: "Олена", status: "INTERVIEW_SCHEDULED",
            interviewSlotId: "local-slot-1", interviewSlot: { startTime: startsIn2h },
        });
        findAvailableInterviewSlots.mockResolvedValue([
            { id: WEB_SLOT_ID, startTime: new Date(Date.now() + 26 * 3600e3) },
        ]);

        const ctx = makeCtx(111006);
        await bookingHandlers.__runCallback(buildSignedCallback("rb", "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).not.toHaveBeenCalled();
        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(findAvailableInterviewSlots).toHaveBeenCalledTimes(1);
        expect(ctx.editMessageText).toHaveBeenCalled();
    });

    it("гард: записана може обрати новий слот до початку співбесіди — це перенос", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "INTERVIEW_SCHEDULED", gender: "female", currentStep: "INTERVIEW",
            notificationSent: true, interviewSlotId: "local-slot-1",
            interviewSlot: { startTime: new Date(Date.now() + 2 * 3600e3) },
        });
        const ctx = makeCtx(111030);
        ctx.callbackQuery = { data: `book_slot_${WEB_SLOT_ID}` };
        const next = vi.fn();

        await (bookingHandlers as any).onHandlers[0](ctx, next);

        expect(next).toHaveBeenCalled();
    });

    it("гард: «не бачу зручного часу» при переносі лишає запис як є", async () => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "INTERVIEW_SCHEDULED", gender: "female", currentStep: "INTERVIEW",
            notificationSent: true, interviewSlotId: "local-slot-1",
            interviewSlot: { startTime: new Date(Date.now() + 2 * 3600e3) },
        });
        const ctx = makeCtx(111031);
        ctx.callbackQuery = { data: "no_slots_fit" };
        const next = vi.fn();

        await (bookingHandlers as any).onHandlers[0](ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Ваш запис лишається без змін");
    });

    it("book_slot_ записаної бронює новий час через той самий шлях (обмін у вебаппі)", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", userId: "user-1", interviewSlotId: "local-slot-1" });
        bookInterviewSlotFlow.mockResolvedValue({
            slot: { id: "local-mirror-2", startTime: new Date(Date.now() + 26 * 3600e3), candidate: { fullName: "Олена", userId: "user-1" } },
            googleEvent: { meetLink: "https://meet.example/abc", eventId: "ev-2" },
        });

        const ctx = makeCtx(111032);
        await bookingHandlers.__runCallback(`book_slot_${WEB_SLOT_ID}`, ctx);

        expect(bookInterviewSlotFlow).toHaveBeenCalledWith(111032, WEB_SLOT_ID, "olena");
    });

    // Та сама пастка з іншого боку: о 15:31 кандидатка, яка чекала HR з 15:15,
    // натиснула «Змінити час» і зняла себе із запису.
    it.each(["rb", "cb", "wi"])("після початку співбесіди стара кнопка «%s» нічого не змінює", async (code) => {
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "INTERVIEW_SCHEDULED", gender: "female", currentStep: "INTERVIEW",
            interviewSlotId: "local-slot-1", interviewSlot: { startTime: new Date(Date.now() - 16 * 60e3) },
        });

        const ctx = makeCtx(111033);
        await bookingHandlers.__runCallback(buildSignedCallback(code, "local-slot-1"), ctx);

        expect(releaseCanonicalInterviewSlot).not.toHaveBeenCalled();
        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Співбесіда вже почалася");
    });

    it("«Я на зв'язку» після початку передає сигнал рекрутерці один раз", async () => {
        const { awsBusinessClient } = await import("../../services/aws-business-client.js");
        findByTelegramId.mockResolvedValue({
            id: "cand-1", status: "INTERVIEW_SCHEDULED", gender: "female", currentStep: "INTERVIEW",
            interviewSlotId: "local-slot-9", interviewSlot: { startTime: new Date(Date.now() - 10 * 60e3) },
        });

        const first = makeCtx(111034);
        await bookingHandlers.__runCallback(buildSignedCallback("hw", "local-slot-9"), first);
        const second = makeCtx(111034);
        await bookingHandlers.__runCallback(buildSignedCallback("hw", "local-slot-9"), second);

        expect((awsBusinessClient as any).pushIncomingRecruitingMessage).toHaveBeenCalledTimes(1);
        expect((awsBusinessClient as any).pushIncomingRecruitingMessage).toHaveBeenCalledWith(
            expect.objectContaining({ telegramId: "111034", body: expect.stringContaining("на зв’язку") }),
        );
    });

    it("a failed canonical release blocks the local cancel — the web slot must not stay taken silently", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", fullName: "Олена", status: "INTERVIEW_SCHEDULED", interviewSlotId: "local-slot-1" });
        releaseCanonicalInterviewSlot.mockRejectedValue(new Error("HTTP 502"));

        const ctx = makeCtx(111007);
        await bookingHandlers.__runCallback(buildSignedCallback("ccb", "local-slot-1"), ctx);

        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Сталася помилка");
    });
});
