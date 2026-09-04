import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Зеркалирование входящих сообщений кандидаток в тред вебаппа (фаза 3b).
 * Хук НЕ вмешивается в обработку: fire-and-forget с .catch, недоступный вебапп
 * никогда не ломает собственные ответы бота. 404 RECRUITING_CANDIDATE_NOT_FOUND
 * — молчаливый пропуск (кандидатки ещё нет в зеркале), это не ошибка.
 */
let flagEnabled = true;

vi.mock("../../config.js", () => ({
    get AWS_RECRUITING_COMMANDS_ENABLED() {
        return flagEnabled;
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

const makeCtx = (overrides: Partial<Record<string, unknown>> = {}) => ({
    chat: { type: "private", id: 1164289764 },
    from: { id: 1164289764, is_bot: false },
    dbUser: null,
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
