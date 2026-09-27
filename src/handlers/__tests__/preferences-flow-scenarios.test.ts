import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, Context } from "grammy";

/**
 * Сценарии флоу пожеланий: настоящие обработчики, настоящий grammy `Context`,
 * замоканы только границы — база бота, API вебаппа, Redis, отрисовка экрана и
 * сам Telegram. Проверяется то, что видит и нажимает фотограф: какие кнопки,
 * что будет при двойном нажатии, старой кнопке, закрытом сборе, сбое сети.
 */

const user = {
    id: "u1",
    telegramId: 111n,
    staffProfile: { id: "sp1", isActive: true, fullName: "Тест Фотограф", awsEmployeePublicId: "4a1c4f32-2b37-4f0c-9d0c-2d1f7a0c3e11" },
    candidate: null,
};

const findWithProfilesByTelegramId = vi.fn();
const schedulePreferenceSchedule = vi.fn();
const getSchedulePreference = vi.fn();
const saveCanonicalPreference = vi.fn();
const readCanonicalPreferenceDays = vi.fn();
const pendingUpdateMany = vi.fn();
const renderScreen = vi.fn();

vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: { findWithProfilesByTelegramId },
}));
vi.mock("../../services/aws-business-client.js", () => ({
    awsBusinessClient: { schedulePreferenceSchedule, getSchedulePreference },
}));
vi.mock("../../services/canonical-preferences-writer.js", () => ({
    saveCanonicalPreference,
    readCanonicalPreferenceDays,
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { updateMany: pendingUpdateMany },
}));
vi.mock("../../services/preferences-service.js", () => ({ preferencesService: {} }));
vi.mock("../../core/redis.js", () => ({ redis: { set: vi.fn() } }));
vi.mock("../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen } }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));
vi.mock("../../config.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../config.js")>()),
    ADMIN_IDS: [],
}));

const { preferencesHandlers, handlePreferenceComment } = await import("../preferences-flow.js");

type ApiCall = { method: string; payload: any };
let calls: ApiCall[] = [];
let session: any;
let updateId = 0;
let testIndex = 0;

const api = new Api("0:test");
api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result = method === "sendMessage"
        ? { message_id: 900 + calls.length, date: 0, chat: { id: 111, type: "private" }, text: "" }
        : true;
    return { ok: true, result } as any;
});
const me = { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any;
const from = { id: 111, is_bot: false, first_name: "Тест" };
const chat = { id: 111, type: "private" as const, first_name: "Тест" };

async function tap(data: string, messageId = 50) {
    const ctx = new Context({
        update_id: ++updateId,
        callback_query: {
            id: String(updateId),
            from,
            chat_instance: "ci",
            data,
            message: { message_id: messageId, date: 0, chat, text: "screen" },
        },
    } as any, api, me) as any;
    ctx.session = session;
    await preferencesHandlers.middleware()(ctx, async () => { });
    return ctx;
}

async function send(text: string): Promise<boolean> {
    const ctx = new Context({
        update_id: ++updateId,
        message: { message_id: 70 + updateId, date: 0, chat, from, text },
    } as any, api, me) as any;
    ctx.session = session;
    return handlePreferenceComment(ctx);
}

const answers = () => calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.payload.text);
const lastScreen = () => renderScreen.mock.calls.at(-1) as [unknown, string, any, unknown] | undefined;
const buttons = (kb: any): string[] => (kb?.inline_keyboard ?? []).flat().map((button: any) => button.callback_data);

beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    session = { step: "idle", navStack: [], messagesToDelete: [] };
    // 24 жовтня, з 12:00 Київ: після 23-го активний штат заповнює листопад.
    // Кожен тест на 2 хвилини пізніше: захист від дребезгу й відмітка «щойно
    // збережено» живуть на рівні модуля, і тест не має бачити сліди сусіда.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(Date.parse("2026-10-24T09:00:00Z") + testIndex++ * 2 * 60_000));
    findWithProfilesByTelegramId.mockResolvedValue(user);
    schedulePreferenceSchedule.mockResolvedValue({
        month: "2026-11",
        open: true,
        deadline: "2026-10-26",
        deadlineEndsAt: "2026-10-26T22:00:00.000Z",
    });
    getSchedulePreference.mockResolvedValue({ worksUntil: null });
    readCanonicalPreferenceDays.mockResolvedValue(undefined);
    saveCanonicalPreference.mockResolvedValue({ ok: true });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("happy path", () => {
    it("opens November, toggles days, lands on a confirmation with save first, and saves once", async () => {
        await tap("pref_fill");
        expect(session.preferencesData.month).toBe("листопад");
        expect(buttons(lastScreen()![2])).toContain("pref_to_comment_none");

        await tap("pref_toggle_3");
        await tap("pref_toggle_3"); // передумала
        await tap("pref_toggle_5");
        expect(session.preferencesData.selectedDays).toEqual([5]);
        expect(buttons(lastScreen()![2])).toContain("pref_to_comment");

        await tap("pref_to_comment");
        const [, text, kb] = lastScreen()!;
        expect(text).toContain("Перевір і збережи");
        expect(text).toContain("ще не надіслані");
        expect(buttons(kb)[0]).toBe("pref_save_final");
        expect(buttons(kb)).toEqual(["pref_save_final", "pref_add_comment", "pref_back_calendar", "pref_cancel_flow"]);

        await tap("pref_save_final");
        expect(saveCanonicalPreference).toHaveBeenCalledTimes(1);
        expect(saveCanonicalPreference.mock.calls[0]![0]).toMatchObject({ month: "2026-11", selectedDays: [5], declined: false });
        // Экран «ще не надіслані» не остаётся висеть после сохранения.
        expect(calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 50)).toBe(true);
        expect(lastScreen()![1]).toContain("успішно збережені");
        expect(session.preferencesData).toBeUndefined();
        expect(pendingUpdateMany).toHaveBeenCalledTimes(1);
    });

    it("saves 'no wishes' as an empty submission", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_save_final");

        expect(saveCanonicalPreference.mock.calls[0]![0]).toMatchObject({ selectedDays: [] });
    });

    it("keeps the marked days when going back to change them", async () => {
        await tap("pref_fill");
        await tap("pref_toggle_7");
        await tap("pref_to_comment");
        await tap("pref_back_calendar");

        expect(session.preferencesData.selectedDays).toEqual([7]);
        expect(lastScreen()![1]).toContain("Побажання (листопад)");
    });
});

describe("double taps", () => {
    it("strips the confirmation buttons while the save is running", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_save_final");

        const strip = calls.find((call) => call.method === "editMessageReplyMarkup");
        expect(strip?.payload.reply_markup).toEqual({ inline_keyboard: [] });
    });

    /**
     * Так двойное нажатие приходит в проде: `sequentialize` отдаёт второе
     * нажатие после того, как первое уже сохранило и удалило сессию.
     */
    it("confirms a second tap that arrives after the save finished, without reopening the form", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_save_final");
        renderScreen.mockClear();

        await tap("pref_save_final");

        expect(saveCanonicalPreference).toHaveBeenCalledTimes(1);
        expect(answers()).toContain("Побажання вже збережені.");
        expect(renderScreen).not.toHaveBeenCalled();
    });

    /** Нажатие на старый экран много позже — не «Помилка.», а свежая форма. */
    it("reopens the form when an old save button is tapped much later", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_save_final");
        vi.advanceTimersByTime(61_000);

        calls = [];
        await tap("pref_save_final");

        expect(saveCanonicalPreference).toHaveBeenCalledTimes(1);
        // Ответ сразу и без текста — открытие формы может занять дольше 15 секунд Telegram.
        expect(answers()).toEqual([undefined]);
        expect(lastScreen()![1]).toContain("Побажання (листопад)");
    });
});

describe("saving again right after a save", () => {
    /** Окно от дребезга держалось 10 секунд и после успеха — правка сразу после сохранения пропадала. */
    it("saves a correction made seconds after the first save", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_save_final");

        await tap("pref_fill");
        await tap("pref_toggle_12");
        await tap("pref_to_comment");
        await tap("pref_save_final");

        expect(saveCanonicalPreference).toHaveBeenCalledTimes(2);
        expect(saveCanonicalPreference.mock.calls[1]![0]).toMatchObject({ selectedDays: [12] });
    });
});

describe("stale buttons", () => {
    /**
     * Сессия живёт сутки. Кнопки старого календаря остаются в чате — раньше они
     * отвечали «Сесія застаріла.» или молчали, и человек стоял перед мёртвым экраном.
     */
    it.each(["pref_toggle_4", "pref_to_comment", "pref_to_comment_none", "pref_add_comment", "pref_back_calendar", "pref_skip_comment", "pref_restart_flow", "pref_save_final"])(
        "%s without a session reopens the form",
        async (data) => {
            await tap(data);

            // Ответ сразу и без текста — открытие формы может занять дольше 15 секунд Telegram.
            expect(answers()).toEqual([undefined]);
            expect(session.preferencesData?.step).toBe("CALENDAR");
            expect(saveCanonicalPreference).not.toHaveBeenCalled();
        },
    );

    it("shows the days already submitted when the form reopens", async () => {
        readCanonicalPreferenceDays.mockResolvedValue([2, 9]);

        await tap("pref_save_final");

        expect(session.preferencesData.selectedDays).toEqual([2, 9]);
        expect(lastScreen()![1]).toContain("Ти вже надсилала побажання");
    });
});

describe("unavailable calendar cells", () => {
    /**
     * «·» раньше слал `none` без обработчика: щит устаревших кнопок удалял
     * календарь и выбрасывал в меню — по промаху мимо числа.
     */
    it("answers a tap on a blocked cell without touching the screen", async () => {
        await tap("pref_fill");
        renderScreen.mockClear();
        calls = [];

        await tap("pref_noop");

        expect(answers()).toEqual(["Цей день не можна вибрати."]);
        expect(renderScreen).not.toHaveBeenCalled();
        expect(calls.some((call) => call.method === "deleteMessage")).toBe(false);
    });

    it("quietly answers the legacy `none` cell of calendars still in chats", async () => {
        await tap("none");

        expect(calls).toEqual([expect.objectContaining({ method: "answerCallbackQuery" })]);
    });

    it("renders blocked cells with the handled callback", async () => {
        getSchedulePreference.mockResolvedValue({ worksUntil: "2026-11-20" });

        await tap("pref_fill");

        const data = buttons(lastScreen()![2]);
        expect(data).toContain("pref_noop");
        expect(data).not.toContain("none");
        expect(data).not.toContain("pref_toggle_21");
    });

    it("rejects a past day toggled from yesterday's current-month calendar", async () => {
        session.preferencesData = { step: "CALENDAR", month: "жовтень", year: 2026, selectedDays: [], comment: "" };

        await tap("pref_toggle_10");

        expect(answers()).toContain("Цей день не можна вибрати.");
        expect(session.preferencesData.selectedDays).toEqual([]);
    });
});

describe("collection window", () => {
    it("says the collection is closed before any day is marked", async () => {
        schedulePreferenceSchedule.mockResolvedValue({ month: "2026-11", open: false, deadline: "2026-10-26", deadlineEndsAt: "2026-10-26T22:00:00.000Z" });

        await tap("pref_fill");

        const [, text, kb] = lastScreen()!;
        expect(text).toContain("уже закрито");
        expect(text).toContain("звернись у підтримку");
        expect(buttons(kb)).toEqual(["open_support_dialog", "staff_hub_nav"]);
        expect(session.preferencesData).toBeUndefined();
    });

    it("opens the form when the window cannot be read, like the menu button does", async () => {
        schedulePreferenceSchedule.mockRejectedValue(new Error("timeout"));

        await tap("pref_fill");

        expect(session.preferencesData?.step).toBe("CALENDAR");
    });

    it("closed at save time: no retry, the confirmation goes away, support is one tap", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        saveCanonicalPreference.mockResolvedValue({ ok: false, reasonCode: "SCHEDULE_PREFERENCES_CLOSED" });
        renderScreen.mockClear();

        await tap("pref_save_final");

        const reply = calls.find((call) => call.method === "sendMessage" && String(call.payload.text).includes("уже закрито"));
        expect(buttons(reply?.payload.reply_markup)).toEqual(["open_support_dialog"]);
        expect(calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 50)).toBe(true);
        expect(renderScreen).not.toHaveBeenCalled();
    });
});

describe("save failure", () => {
    it("says so in the staff voice and brings the save button back", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        saveCanonicalPreference.mockResolvedValueOnce({ ok: false, reasonCode: "CANONICAL_PREFERENCE_WRITE_FAILED" });

        await tap("pref_save_final");

        const reply = calls.find((call) => call.method === "sendMessage" && String(call.payload.text).includes("Не вдалося"));
        expect(reply?.payload.text).toContain("Спробуй ще раз");
        expect(buttons(lastScreen()![2])[0]).toBe("pref_save_final");
        expect(session.preferencesData).toBeDefined();
    });

    it("lets the offered retry through immediately", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        saveCanonicalPreference.mockResolvedValueOnce({ ok: false, reasonCode: "CANONICAL_PREFERENCE_WRITE_FAILED" });

        await tap("pref_save_final");
        await tap("pref_save_final");

        expect(saveCanonicalPreference).toHaveBeenCalledTimes(2);
        expect(lastScreen()![1]).toContain("успішно збережені");
    });
});

describe("comment", () => {
    async function onCommentStep() {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_add_comment");
        expect(session.preferencesData.step).toBe("COMMENT");
    }

    it("takes the next message as the comment and returns to the confirmation", async () => {
        await onCommentStep();

        expect(await send("  хочу більше змін  ")).toBe(true);

        expect(session.preferencesData.comment).toBe("хочу більше змін");
        expect(session.preferencesData.step).toBe("CONFIRM");
        const [, text, kb] = lastScreen()!;
        expect(text).toContain("хочу більше змін");
        expect(buttons(kb)[0]).toBe("pref_save_final");
    });

    it("lets a command through instead of saving it as a comment", async () => {
        await onCommentStep();

        expect(await send("/start")).toBe(false);
        expect(session.preferencesData.comment).toBe("");
    });

    /** API режет `comment` на 500 символах 400-м — сохранение падало бы вечно. */
    it("rejects a comment the API would refuse and keeps waiting for a shorter one", async () => {
        await onCommentStep();

        expect(await send("а".repeat(501))).toBe(true);

        expect(session.preferencesData.step).toBe("COMMENT");
        expect(session.preferencesData.comment).toBe("");
        const reply = calls.find((call) => call.method === "sendMessage" && String(call.payload.text).includes("задовгий"));
        expect(reply?.payload.text).toContain("501");
    });

    /** Брошенный шаг комментария не съедает сообщение в підтримку через час. */
    it("stops capturing once the comment step has been abandoned", async () => {
        await onCommentStep();
        vi.advanceTimersByTime(31 * 60 * 1000);

        expect(await send("Доброго дня, питання по зарплаті")).toBe(false);

        expect(session.preferencesData.comment).toBe("");
        expect(session.preferencesData.step).toBe("CONFIRM");
    });

    it("never captures text on the confirmation screen itself", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");

        expect(await send("питання в підтримку")).toBe(false);
    });

    it("clears the comment with «Без коментаря»", async () => {
        await onCommentStep();
        await send("можу на іншій локації");
        await tap("pref_add_comment");

        await tap("pref_skip_comment");

        expect(session.preferencesData.comment).toBe("");
        expect(session.preferencesData.step).toBe("CONFIRM");
    });
});

describe("leaving", () => {
    it("drops the form on cancel and writes nothing", async () => {
        await tap("pref_fill");
        await tap("pref_toggle_5");

        await tap("pref_cancel_flow");

        expect(session.preferencesData).toBeUndefined();
        expect(saveCanonicalPreference).not.toHaveBeenCalled();
    });
});

describe("findings of the review", () => {
    /**
     * Владелец закрыл сбор и нажал «Reopen for X». Проверка окна при открытии
     * формы не видела личного окна, и X получал «збір закрито».
     */
    it("lets a reopened person in: the window check carries the employee", async () => {
        await tap("pref_fill");

        expect(schedulePreferenceSchedule).toHaveBeenCalledWith("2026-11", user.staffProfile.awsEmployeePublicId);
        expect(session.preferencesData?.step).toBe("CALENDAR");
    });

    /** Кнопка старого экрана подтверждения, нажатая из календаря, записала бы правку на полпути. */
    it("does not save from anywhere but the confirmation screen", async () => {
        await tap("pref_fill");
        await tap("pref_toggle_5");
        await tap("pref_to_comment");
        await tap("pref_back_calendar");
        await tap("pref_toggle_9");

        await tap("pref_save_final");

        expect(saveCanonicalPreference).not.toHaveBeenCalled();
        expect(session.preferencesData.step).toBe("CONFIRM");
        expect(lastScreen()![1]).toContain("Перевір і збережи");
        expect(answers()).toContain("Перевір дні й натисни «Зберегти» ще раз.");
    });

    /** «Без коментаря» был единственным выходом и стирал написанное. */
    it("keeps the comment when leaving the comment screen with «Назад»", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");
        await tap("pref_add_comment");
        await send("можу на іншій локації");
        await tap("pref_add_comment");
        expect(buttons(lastScreen()![2])).toEqual(["pref_comment_back", "pref_skip_comment"]);

        await tap("pref_comment_back");

        expect(session.preferencesData.comment).toBe("можу на іншій локації");
        expect(session.preferencesData.step).toBe("CONFIRM");
    });

    it("offers no «Прибрати коментар» when there is nothing to remove", async () => {
        await tap("pref_fill");
        await tap("pref_to_comment_none");

        await tap("pref_add_comment");

        expect(buttons(lastScreen()![2])).toEqual(["pref_comment_back"]);
    });

    /** Тост «Форму оновлено» над экраном «збір закрито» противоречил бы экрану. */
    it("does not say the form was refreshed when it opens on a closed collection", async () => {
        schedulePreferenceSchedule.mockResolvedValue({ month: "2026-11", open: false, deadline: "2026-10-26", deadlineEndsAt: "2026-10-26T22:00:00.000Z" });

        await tap("pref_toggle_4");

        expect(answers()).toEqual([undefined]);
        expect(lastScreen()![1]).toContain("уже закрито");
    });

    /** Удалённые кнопки из старых сообщений: без ответа у человека висел бы спиннер. */
    it.each(["pref_opt_out", "pref_force_edit", "pref_something_retired"])(
        "answers the retired %s once with a fresh form",
        async (data) => {
            await tap(data);

            expect(answers()).toHaveLength(1);
            expect(session.preferencesData?.step).toBe("CALENDAR");
            expect(saveCanonicalPreference).not.toHaveBeenCalled();
        },
    );
});

