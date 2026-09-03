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

    it("не-текстовое сообщение (фото) — без пуша", async () => {
        const ctx = makeCtx({ message: { message_id: 56, date: 1_756_300_000, photo: [{ file_id: "f1" }] } });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).not.toHaveBeenCalled();
    });

    it("групповой чат — без пуша", async () => {
        const ctx = makeCtx({ chat: { type: "supergroup", id: -100123 } });

        await recruitingIncomingMiddleware(ctx as never, vi.fn());
        await flush();

        expect(pushIncoming).not.toHaveBeenCalled();
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
