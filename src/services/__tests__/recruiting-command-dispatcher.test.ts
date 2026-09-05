import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Диспетчер команд рекрутёра (фаза 3a): забирает pending из outbox вебаппа и
 * применяет каждую команду ТЕМИ ЖЕ вызовами hr-service, что и кнопки HR-меню.
 * Здесь проверяется маппинг kind → действие, поштучная изоляция сбоев и
 * честные applied/failed-ack'и; сами действия воронки покрыты hr-service.test.
 */
const listPending = vi.fn();
const ackApplied = vi.fn();
const ackFailed = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingRecruitingCommands: listPending,
        ackRecruitingCommandApplied: ackApplied,
        ackRecruitingCommandFailed: ackFailed,
    },
}));

const inviteCandidate = vi.fn();
const makeDecision = vi.fn();
const markNoShow = vi.fn();
const rejectCandidate = vi.fn();

vi.mock("../hr-service.js", () => ({
    hrService: {
        inviteCandidate,
        makeDecision,
        markNoShow,
        rejectCandidate,
    },
}));

const findByTelegramId = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId },
}));

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
vi.mock("../../utils/cleanup.js", () => ({
    trackUserMessage: vi.fn().mockResolvedValue(undefined),
    cleanupUserSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

const { RecruitingCommandDispatcher } = await import("../recruiting-command-dispatcher.js");

const makeApi = () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }) });

const command = (overrides: Partial<Record<string, unknown>> = {}) => ({
    publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    kind: "INVITE_TO_INTERVIEW",
    reasonCode: null,
    reasonText: null,
    attempts: 0,
    candidate: {
        telegramId: "1164289764",
        botCandidateId: "cand-1",
        publicId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    },
    ...overrides,
});

const localCandidate = {
    id: "cand-1",
    user: { id: "user-1", telegramId: 1164289764n },
};

beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue("OK");
    redisEval.mockResolvedValue(1);
    findByTelegramId.mockResolvedValue(localCandidate);
    inviteCandidate.mockResolvedValue({ ok: true });
    makeDecision.mockResolvedValue(true);
    markNoShow.mockResolvedValue(true);
    rejectCandidate.mockResolvedValue(true);
    listPending.mockResolvedValue({ items: [] });
    ackApplied.mockResolvedValue({ publicId: "x", status: "APPLIED" });
    ackFailed.mockResolvedValue({ publicId: "x", status: "PENDING" });
});

afterEach(() => vi.restoreAllMocks());

describe("RecruitingCommandDispatcher", () => {
    it("fetches pending commands with the agreed limit of 20", async () => {
        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);
        expect(listPending).toHaveBeenCalledWith(20);
    });

    it("skips the whole pass when another instance holds the Redis lease", async () => {
        redisSet.mockResolvedValue(null);
        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);
        expect(listPending).not.toHaveBeenCalled();
    });

    it("INVITE_TO_INTERVIEW calls the same inviteCandidate the HR button calls, then acks applied", async () => {
        const api = makeApi();
        listPending.mockResolvedValue({ items: [command({ kind: "INVITE_TO_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(findByTelegramId).toHaveBeenCalledWith(1164289764);
        expect(inviteCandidate).toHaveBeenCalledWith(api, "cand-1");
        expect(ackApplied).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e");
        expect(ackFailed).not.toHaveBeenCalled();
    });

    it("ACCEPT_AFTER_INTERVIEW maps to makeDecision(..., 'ACCEPTED')", async () => {
        const api = makeApi();
        listPending.mockResolvedValue({ items: [command({ kind: "ACCEPT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(makeDecision).toHaveBeenCalledWith(api, "cand-1", "ACCEPTED", expect.any(String));
        expect(ackApplied).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e");
    });

    it("REJECT_AFTER_INTERVIEW maps to makeDecision(..., 'REJECTED')", async () => {
        const api = makeApi();
        listPending.mockResolvedValue({ items: [command({ kind: "REJECT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(makeDecision).toHaveBeenCalledWith(api, "cand-1", "REJECTED", expect.any(String));
        expect(ackApplied).toHaveBeenCalled();
    });

    it("MARK_NO_SHOW maps to markNoShow and sends the same rejection text the HR button sends", async () => {
        const api = makeApi();
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_NO_SHOW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(markNoShow).toHaveBeenCalledWith("cand-1");
        expect(api.sendMessage).toHaveBeenCalledWith(1164289764, expect.any(String));
        expect(ackApplied).toHaveBeenCalled();
    });

    it("MARK_NO_SHOW still acks applied when the courtesy message cannot be delivered", async () => {
        const api = makeApi();
        api.sendMessage.mockRejectedValue(new Error("bot was blocked by the user"));
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_NO_SHOW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(markNoShow).toHaveBeenCalledWith("cand-1");
        expect(ackApplied).toHaveBeenCalled();
        expect(ackFailed).not.toHaveBeenCalled();
    });

    it("REJECT maps to the pre-interview rejectCandidate with the GENERAL code", async () => {
        const api = makeApi();
        listPending.mockResolvedValue({ items: [command({ kind: "REJECT" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(rejectCandidate).toHaveBeenCalledWith(api, "cand-1", "GENERAL");
        expect(ackApplied).toHaveBeenCalled();
    });

    it("acks CANDIDATE_NOT_FOUND_IN_BOT when the telegramId resolves to no local candidate", async () => {
        findByTelegramId.mockResolvedValue(null);
        listPending.mockResolvedValue({ items: [command()] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "CANDIDATE_NOT_FOUND_IN_BOT",
        );
        expect(inviteCandidate).not.toHaveBeenCalled();
        expect(ackApplied).not.toHaveBeenCalled();
    });

    it("acks a loud UNKNOWN_COMMAND_KIND for a kind this bot version does not know", async () => {
        listPending.mockResolvedValue({ items: [command({ kind: "PROMOTE_TO_MENTOR" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "UNKNOWN_COMMAND_KIND:PROMOTE_TO_MENTOR",
        );
        expect(ackApplied).not.toHaveBeenCalled();
    });

    it("acks failed when the invite could not be sent, carrying the refusal reason", async () => {
        inviteCandidate.mockResolvedValue({ ok: false, reason: "bot_blocked" });
        listPending.mockResolvedValue({ items: [command({ kind: "INVITE_TO_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("bot_blocked"),
        );
        expect(ackApplied).not.toHaveBeenCalled();
    });

    it("does not claim the invite was never sent when only the state write failed", async () => {
        inviteCandidate.mockResolvedValue({ ok: false, reason: "state_write_failed" });
        listPending.mockResolvedValue({ items: [command({ kind: "INVITE_TO_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("state_write_failed"),
        );
        expect(ackFailed).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("INVITE_NOT_SENT"),
        );
    });

    it("surfaces the funnel guard's reasonCode when the transition is refused", async () => {
        const guardError = Object.assign(new Error("Invalid transition"), {
            reasonCode: "DECISION_ALREADY_MADE",
        });
        makeDecision.mockRejectedValue(guardError);
        listPending.mockResolvedValue({ items: [command({ kind: "ACCEPT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("DECISION_ALREADY_MADE"),
        );
    });

    it("truncates a long error message before reporting it", async () => {
        makeDecision.mockRejectedValue(new Error("x".repeat(600)));
        listPending.mockResolvedValue({ items: [command({ kind: "ACCEPT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        const [, reported] = ackFailed.mock.calls[0]!;
        expect((reported as string).length).toBeLessThanOrEqual(450);
    });

    it("keeps processing the queue after one command throws", async () => {
        const api = makeApi();
        listPending.mockResolvedValue({
            items: [
                command({ publicId: "11111111-1111-4111-8111-111111111111", kind: "ACCEPT_AFTER_INTERVIEW" }),
                command({ publicId: "22222222-2222-4222-8222-222222222222", kind: "REJECT" }),
            ],
        });
        makeDecision.mockRejectedValue(new Error("db down"));

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "11111111-1111-4111-8111-111111111111",
            expect.stringContaining("db down"),
        );
        expect(rejectCandidate).toHaveBeenCalledWith(api, "cand-1", "GENERAL");
        expect(ackApplied).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
    });

    it("keeps processing the queue when an ack itself fails", async () => {
        listPending.mockResolvedValue({
            items: [
                command({ publicId: "11111111-1111-4111-8111-111111111111", kind: "REJECT" }),
                command({ publicId: "22222222-2222-4222-8222-222222222222", kind: "REJECT" }),
            ],
        });
        ackApplied.mockRejectedValueOnce(new Error("network"));

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackApplied).toHaveBeenCalledTimes(2);
        expect(ackApplied).toHaveBeenLastCalledWith("22222222-2222-4222-8222-222222222222");
    });
});
