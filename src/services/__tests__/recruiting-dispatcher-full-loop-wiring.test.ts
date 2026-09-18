import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Полный цикл найма живёт в ТОМ ЖЕ минутном тике диспетчера команд и под той
 * же Redis-лизой: команды → исходящие сообщения. Отдельного флага нет — всё
 * гейтится существующим AWS_RECRUITING_COMMANDS_ENABLED в worker.
 *
 * Третьего прохода — рассылок по пулу города — здесь больше нет: он опрашивал
 * фид `broadcasts/pending`, снесённый на стороне вебаппа 16.09.2026 вместе со
 * старым контуром INVITE. Приглашения давно идут поимённо, командами.
 */
const listPending = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingRecruitingCommands: listPending,
        ackRecruitingCommandApplied: vi.fn(),
        ackRecruitingCommandFailed: vi.fn(),
    },
}));

vi.mock("../hr-service.js", () => ({ hrService: {} }));
vi.mock("../team-registration-service.js", () => ({ teamRegistrationService: {} }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));

const deliverPendingRecruitingMessages = vi.fn();
vi.mock("../recruiting-message-delivery.js", () => ({ deliverPendingRecruitingMessages }));

const redisSet = vi.fn();
const redisEval = vi.fn();

vi.mock("../../core/redis.js", () => ({
    redis: {
        set: (...args: unknown[]) => redisSet(...args),
        eval: (...args: unknown[]) => redisEval(...args),
    },
}));

vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { RecruitingCommandDispatcher } = await import("../recruiting-command-dispatcher.js");

const makeApi = () => ({ sendMessage: vi.fn() });

beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue("OK");
    redisEval.mockResolvedValue(1);
    listPending.mockResolvedValue({ items: [] });
    deliverPendingRecruitingMessages.mockResolvedValue({ sent: 0, failed: 0 });
});

afterEach(() => vi.restoreAllMocks());

describe("RecruitingCommandDispatcher: тик полного цикла", () => {
    it("после команд гоняет доставку сообщений тем же Api", async () => {
        const api = makeApi();
        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(deliverPendingRecruitingMessages).toHaveBeenCalledWith(api);
    });

    it("чужая лиза — ни команд, ни сообщений", async () => {
        redisSet.mockResolvedValue(null);
        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(listPending).not.toHaveBeenCalled();
        expect(deliverPendingRecruitingMessages).not.toHaveBeenCalled();
    });

    /**
     * Проход спроектирован «никогда не бросать», но гарантия важна и без
     * второго прохода рядом: сбой доставки не должен уносить с собой лизу —
     * иначе она дотикает до TTL, и следующий тик встанет на пять минут.
     */
    it("упавшая доставка сообщений не срывает тик и отпускает лизу", async () => {
        deliverPendingRecruitingMessages.mockRejectedValue(new Error("boom"));

        await expect(
            new RecruitingCommandDispatcher().runOnce(makeApi() as never),
        ).resolves.not.toThrow();
        expect(redisEval).toHaveBeenCalled();
    });
});
