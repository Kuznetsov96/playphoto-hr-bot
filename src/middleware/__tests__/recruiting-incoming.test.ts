import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Зеркалирование входящих сообщений кандидаток в тред вебаппа (фаза 3b).
 * Хук НЕ вмешивается в обработку: fire-and-forget с .catch, недоступный вебапп
 * никогда не ломает собственные ответы бота. 404 RECRUITING_CANDIDATE_NOT_FOUND
 * — молчаливый пропуск (кандидатки ещё нет в зеркале), это не ошибка.
 */
let flagEnabled = true;

let adminIds: number[] = [107794048];

vi.mock("../../config.js", () => ({
    get AWS_RECRUITING_COMMANDS_ENABLED() {
        return flagEnabled;
    },
    get ADMIN_IDS() {
        return adminIds;
    },
}));

const pushIncoming = vi.fn();

vi.mock("../../services/aws-business-client.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../services/aws-business-client.js")>();
    return {
        AwsBusinessApiError: original.AwsBusinessApiError,
        awsBusinessClient: { pushIncomingRecruitingMessage: pushIncoming },
    };
});

const findByTelegramId = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId },
}));

vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { recruitingIncomingMiddleware } = await import("../recruiting-incoming.js");
const { AwsBusinessApiError } = await import("../../services/aws-business-client.js");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Чуть больше паузы ретрая в middleware — чтобы отложенный DM успел долететь. */
const RETRY_DELAY_SETTLE_MS = 1_200;

const sendMessage = vi.fn();

const makeCtx = (overrides: Partial<Record<string, unknown>> = {}) => ({
    chat: { type: "private", id: 1164289764 },
    from: { id: 1164289764, is_bot: false, username: "kandydatka" },
    dbUser: null,
    api: { sendMessage },
    message: {
        message_id: 55,
        date: 1_756_300_000,
        text: "Доброго дня! Ще актуальна вакансія?",
    },
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    flagEnabled = true;
    findByTelegramId.mockResolvedValue({ id: "cand-1", status: "SCREENING" });
    pushIncoming.mockResolvedValue({ publicId: "msg-1" });
});

afterEach(() => vi.restoreAllMocks());

describe("recruitingIncomingMiddleware", () => {
    it("пушит текст кандидатки в вебапп и не задерживает next()", async () => {
        const ctx = makeCtx();
        const next = vi.fn().mockResolvedValue(undefined);

        await recruitingIncomingMiddleware(ctx as never, next);
        await flush();

        expect(next).toHaveBeenCalled();
        expect(pushIncoming).toHaveBeenCalledWith({
            telegramId: "1164289764",
            body: "Доброго дня! Ще актуальна вакансія?",
            telegramMessageId: "55",
            sentAt: new Date(1_756_300_000 * 1000).toISOString(),
        });
    });

    it("пользователь без Candidate-записи — без пуша", async () => {
        findByTelegramId.mockResolvedValue(null);
        const next = vi.fn();

        await recruitingIncomingMiddleware(makeCtx() as never, next);
        await flush();

        expect(pushIncoming).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it("активный сотрудник — без пуша и без запроса кандидатки", async () => {
        const ctx = makeCtx({ dbUser: { id: "u1", staffProfile: { id: "s1", isActive: true } } });
        const next = vi.fn();

        await recruitingIncomingMiddleware(ctx as never, next);
        await flush();

        expect(findByTelegramId).not.toHaveBeenCalled();
        expect(pushIncoming).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it("кандидатка уже HIRED — без пуша", async () => {
        findByTelegramId.mockResolvedValue({ id: "cand-1", status: "HIRED" });

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await flush();

        expect(pushIncoming).not.toHaveBeenCalled();
    });

    it("500 вебаппа не ломает обработку бота", async () => {
        pushIncoming.mockRejectedValue(new AwsBusinessApiError(500, undefined, "HTTP 500"));
        const next = vi.fn().mockResolvedValue(undefined);

        await expect(recruitingIncomingMiddleware(makeCtx() as never, next)).resolves.toBeUndefined();
        await flush();

        expect(next).toHaveBeenCalled();
    });

    it("404 RECRUITING_CANDIDATE_NOT_FOUND — молчаливый пропуск", async () => {
        pushIncoming.mockRejectedValue(new AwsBusinessApiError(404, "RECRUITING_CANDIDATE_NOT_FOUND", "HTTP 404"));
        const { logBusinessEvent } = await import("../../core/log-events.js");

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await flush();

        expect(vi.mocked(logBusinessEvent).mock.calls.filter(([e]) => (e as { level?: string }).level === "warn")).toHaveLength(0);
    });

    it("выключенный флаг — хук не делает ни одного запроса", async () => {
        flagEnabled = false;

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await flush();

        expect(findByTelegramId).not.toHaveBeenCalled();
        expect(pushIncoming).not.toHaveBeenCalled();
    });

    it("групповой чат — без пуша", async () => {
        const ctx = makeCtx({ chat: { type: "supergroup", id: -100123 } });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).not.toHaveBeenCalled();
    });

    it("фото: пушит file_id, вид и подпись как текст", async () => {
        const ctx = makeCtx({
            message: {
                message_id: 55,
                date: 1_756_300_000,
                caption: "ось моє фото",
                photo: [
                    { file_id: "small-id" },
                    { file_id: "largest-id" },
                ],
            },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({
                body: "📷 Фото: ось моє фото",
                // Берётся ПОСЛЕДНИЙ элемент photo — это максимальный размер.
                attachment: { fileId: "largest-id", kind: "PHOTO" },
            }),
        );
    });

    it("голосове без підпису: тіло не порожнє (інакше API відповість 400)", async () => {
        const ctx = makeCtx({
            message: { message_id: 56, date: 1_756_300_000, voice: { file_id: "voice-id" } },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({
                body: "🎙 Голосове повідомлення",
                attachment: { fileId: "voice-id", kind: "VOICE" },
            }),
        );
    });

    it("відеозаписка: kind VIDEO_NOTE", async () => {
        const ctx = makeCtx({
            message: { message_id: 57, date: 1_756_300_000, video_note: { file_id: "note-id" } },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({ attachment: { fileId: "note-id", kind: "VIDEO_NOTE" } }),
        );
    });

    it("відео: kind VIDEO", async () => {
        const ctx = makeCtx({
            message: { message_id: 58, date: 1_756_300_000, video: { file_id: "video-id" } },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({ attachment: { fileId: "video-id", kind: "VIDEO" } }),
        );
    });

    it("текстове повідомлення: без блоку attachment", async () => {
        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await flush();

        const payload = pushIncoming.mock.calls[0]?.[0];
        expect(payload.attachment).toBeUndefined();
    });

    it("повідомлення без тексту й без медіа: пуша немає", async () => {
        const ctx = makeCtx({ message: { message_id: 59, date: 1_756_300_000 } });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).not.toHaveBeenCalled();
    });

    it("порядок веток совпадает с getCandidateSupportPayload: photo побеждает video_note", async () => {
        const ctx = makeCtx({
            message: {
                message_id: 60,
                date: 1_756_300_000,
                photo: [{ file_id: "photo-id" }],
                video_note: { file_id: "note-id" },
            },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({ attachment: { fileId: "photo-id", kind: "PHOTO" } }),
        );
    });

    it("порядок веток совпадает с getCandidateSupportPayload: video_note побеждает voice", async () => {
        const ctx = makeCtx({
            message: {
                message_id: 61,
                date: 1_756_300_000,
                video_note: { file_id: "note-id" },
                voice: { file_id: "voice-id" },
            },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({ attachment: { fileId: "note-id", kind: "VIDEO_NOTE" } }),
        );
    });

    it("порядок веток совпадает с getCandidateSupportPayload: voice побеждает video", async () => {
        const ctx = makeCtx({
            message: {
                message_id: 62,
                date: 1_756_300_000,
                voice: { file_id: "voice-id" },
                video: { file_id: "video-id" },
            },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledWith(
            expect.objectContaining({ attachment: { fileId: "voice-id", kind: "VOICE" } }),
        );
    });

    it("длинное тело обрезается до 4000 символов (API отвергает 4096 Telegram-лимитом)", async () => {
        const longText = "а".repeat(4096);
        const ctx = makeCtx({
            message: { message_id: 63, date: 1_756_300_000, text: longText },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        const payload = pushIncoming.mock.calls[0]?.[0];
        expect(payload.body).toHaveLength(4000);
        expect(payload.body).toBe(longText.slice(0, 4000));
    });

    // Приватность: фото на шагах сбора документов и на экране скрининга
    // с татуировкой не должно зеркалиться — см. DOCUMENT_COLLECTION_STEPS
    // в recruiting-incoming.ts.
    describe("документы и скрининг: фото на этих шагах не пушится", () => {
        it("паспорт (перед): фото на ONB_PASSPORT_FRONT — без пуша", async () => {
            const ctx = makeCtx({
                message: { message_id: 70, date: 1_756_300_000, photo: [{ file_id: "passport-front-id" }] },
                session: { candidateData: { step: "ONB_PASSPORT_FRONT" } },
            });

            await recruitingIncomingMiddleware(ctx as never, vi.fn());
            await flush();

            expect(pushIncoming).not.toHaveBeenCalled();
        });

        it("паспорт (зворот): фото на ONB_PASSPORT_BACK — без пуша", async () => {
            const ctx = makeCtx({
                message: { message_id: 71, date: 1_756_300_000, photo: [{ file_id: "passport-back-id" }] },
                session: { candidateData: { step: "ONB_PASSPORT_BACK" } },
            });

            await recruitingIncomingMiddleware(ctx as never, vi.fn());
            await flush();

            expect(pushIncoming).not.toHaveBeenCalled();
        });

        it("прописка/Дія: фото на ONB_PASSPORT_ANNEX — без пуша", async () => {
            const ctx = makeCtx({
                message: { message_id: 72, date: 1_756_300_000, photo: [{ file_id: "annex-id" }] },
                session: { candidateData: { step: "ONB_PASSPORT_ANNEX" } },
            });

            await recruitingIncomingMiddleware(ctx as never, vi.fn());
            await flush();

            expect(pushIncoming).not.toHaveBeenCalled();
        });

        it("фото татуювання на screening_appearance — без пуша", async () => {
            const ctx = makeCtx({
                message: { message_id: 73, date: 1_756_300_000, photo: [{ file_id: "tattoo-id" }] },
                session: { step: "screening_appearance", candidateData: {} },
            });

            await recruitingIncomingMiddleware(ctx as never, vi.fn());
            await flush();

            expect(pushIncoming).not.toHaveBeenCalled();
        });

        it("звичайне фото поза кроками збору документів — усе ще пушиться", async () => {
            const ctx = makeCtx({
                message: { message_id: 74, date: 1_756_300_000, caption: "ось моє фото", photo: [{ file_id: "ordinary-id" }] },
                session: { step: "idle", candidateData: { step: "ONB_FINAL" } },
            });

            await recruitingIncomingMiddleware(ctx as never, vi.fn());
            await flush();

            expect(pushIncoming).toHaveBeenCalledWith(
                expect.objectContaining({ attachment: { fileId: "ordinary-id", kind: "PHOTO" } }),
            );
        });
    });
});

/**
 * «Входящие» рекрутёра — это переписка, а не след работы с ботом. Мидлварь
 * стоит в цепочке РАНЬШЕ перехвата /start и обработчиков анкеты, поэтому
 * отсекать команды и ответы анкеты приходится здесь: ниже по цепочке уже
 * некому. До 03.09.2026 фильтра не было вовсе, и каждая дата рождения,
 * выбранный город и «+» попадали рекрутёру как отдельное сообщение.
 */
describe("recruitingIncomingMiddleware: что НЕ является перепиской", () => {
    it("не зеркалит команды", async () => {
        for (const text of ["/start", "/reset_me", "/help"]) {
            vi.clearAllMocks();
            const ctx = makeCtx({ message: { message_id: 55, date: 1_756_300_000, text } });

            await recruitingIncomingMiddleware(ctx as never, vi.fn().mockResolvedValue(undefined));
            await flush();

            expect(pushIncoming, `команда ${text} не должна уходить рекрутёру`).not.toHaveBeenCalled();
        }
    });

    it("не зеркалит ответы, пока кандидатка заполняет анкету", async () => {
        const steps = ["screening_name", "screening_birthdate", "screening_other_city", "screening_appearance"];
        for (const step of steps) {
            vi.clearAllMocks();
            const ctx = makeCtx({
                session: { step },
                message: { message_id: 55, date: 1_756_300_000, text: "23.03.2009" },
            });

            await recruitingIncomingMiddleware(ctx as never, vi.fn().mockResolvedValue(undefined));
            await flush();

            expect(pushIncoming, `шаг ${step} не должен уходить рекрутёру`).not.toHaveBeenCalled();
        }
    });

    it("зеркалит обычное сообщение вне анкеты", async () => {
        const ctx = makeCtx({ session: { step: "idle" } });

        await recruitingIncomingMiddleware(ctx as never, vi.fn().mockResolvedValue(undefined));
        await flush();

        expect(pushIncoming).toHaveBeenCalled();
    });

    it("зеркалит сообщение, когда шага нет вовсе", async () => {
        const ctx = makeCtx({ session: {} });

        await recruitingIncomingMiddleware(ctx as never, vi.fn().mockResolvedValue(undefined));
        await flush();

        expect(pushIncoming).toHaveBeenCalled();
    });
});

/**
 * Подстраховка после снятия HR-DM (04.09.2026). Вебапп стал единственным
 * каналом для обращений кандидаток, поэтому провалившийся пуш означает
 * ПОТЕРЯННОЕ обращение — кандидатка уверена, что написала, рекрутёр ничего не
 * видит. Тревог на INCOMING_PUSH_FAILED нет, так что аварийный DM владельцу —
 * единственное, что делает сбой заметным.
 */
describe("recruitingIncomingMiddleware: подстраховка при сбое зеркала", () => {
    /**
     * Пуш — fire-and-forget с паузой перед повтором, поэтому его DM может
     * долететь уже ПОСЛЕ конца своего теста и попасть в счётчик следующего.
     * Ждём тишины перед каждым тестом и только потом чистим моки — иначе
     * тест видит чужой вызов и проверяет не то, что написано в его названии.
     */
    beforeEach(async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_SETTLE_MS));
        sendMessage.mockClear();
        pushIncoming.mockClear();
    });

    const waitFor = async (assertion: () => void) => {
        for (let i = 0; i < 40; i += 1) {
            try {
                assertion();
                return;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        assertion();
    };

    it("временный сбой: повторяет пуш и НЕ беспокоит владельца", async () => {
        pushIncoming.mockRejectedValueOnce(new AwsBusinessApiError(502, undefined, "HTTP 502"));
        pushIncoming.mockResolvedValueOnce({ publicId: "msg-1" });

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await waitFor(() => expect(pushIncoming).toHaveBeenCalledTimes(2));

        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("обе попытки провалились: шлёт владельцу полный текст обращения", async () => {
        pushIncoming.mockRejectedValue(new AwsBusinessApiError(500, undefined, "HTTP 500"));

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await waitFor(() => expect(sendMessage).toHaveBeenCalled());

        const [target, text] = sendMessage.mock.calls[0]!;
        expect(target).toBe(107794048);
        // Смысл DM — спасти обращение, а не уведомить о поломке: текст обязан
        // быть внутри, иначе владельцу нечего ответить кандидатке.
        expect(text).toContain("Доброго дня! Ще актуальна вакансія?");
        expect(text).toContain("@kandydatka");
    });

    it("медиа: в аварийном DM видно, что было вложение", async () => {
        pushIncoming.mockRejectedValue(new AwsBusinessApiError(500, undefined, "HTTP 500"));
        const ctx = makeCtx({
            message: { message_id: 90, date: 1_756_300_000, voice: { file_id: "voice-id" } },
        });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await waitFor(() => expect(sendMessage).toHaveBeenCalled());

        expect(sendMessage.mock.calls[0]![1]).toContain("VOICE");
    });

    it("кандидатки нет в зеркале: не повторяет и не пишет владельцу", async () => {
        pushIncoming.mockRejectedValue(
            new AwsBusinessApiError(404, "RECRUITING_CANDIDATE_NOT_FOUND", "HTTP 404"),
        );

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await flush();

        expect(pushIncoming).toHaveBeenCalledTimes(1);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("владельца нет в ADMIN_IDS: молчит, а не падает", async () => {
        adminIds = [];
        pushIncoming.mockRejectedValue(new AwsBusinessApiError(500, undefined, "HTTP 500"));

        await recruitingIncomingMiddleware(makeCtx() as never, vi.fn());
        await flush();

        expect(sendMessage).not.toHaveBeenCalled();
        adminIds = [107794048];
    });
});
