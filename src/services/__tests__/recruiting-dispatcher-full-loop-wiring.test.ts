import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Полный цикл найма живёт в ТОМ ЖЕ минутном тике диспетчера команд и под той
 * же Redis-лизой: команды → исходящие сообщения → рассылки. Отдельного флага
 * нет — всё гейтится существующим AWS_RECRUITING_COMMANDS_ENABLED в worker.
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

const runPendingRecruitingBroadcasts = vi.fn();
vi.mock("../recruiting-broadcast-delivery.js", () => ({ runPendingRecruitingBroadcasts }));

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
    runPendingRecruitingBroadcasts.mockResolvedValue({ processed: 0 });
});

afterEach(() => vi.restoreAllMocks());

describe("RecruitingCommandDispatcher: тик полного цикла", () => {
    it("после команд гоняет доставку сообщений и рассылки тем же Api", async () => {
        const api = makeApi();
        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(deliverPendingRecruitingMessages).toHaveBeenCalledWith(api);
        expect(runPendingRecruitingBroadcasts).toHaveBeenCalledWith(api);
    });

    it("чужая лиза — ни сообщений, ни рассылок", async () => {
        redisSet.mockResolvedValue(null);
        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(deliverPendingRecruitingMessages).not.toHaveBeenCalled();
        expect(runPendingRecruitingBroadcasts).not.toHaveBeenCalled();
    });

    it("упавшая доставка сообщений не срывает рассылки", async () => {
        deliverPendingRecruitingMessages.mockRejectedValue(new Error("boom"));
        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(runPendingRecruitingBroadcasts).toHaveBeenCalled();
    });
});
