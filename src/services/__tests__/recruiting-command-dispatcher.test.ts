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
const rejectAfterInterview = vi.fn();
const acceptAfterInterview = vi.fn();
const markNoShow = vi.fn();
const rejectCandidate = vi.fn();

vi.mock("../hr-service.js", () => ({
    hrService: {
        inviteCandidate,
        makeDecision,
        rejectAfterInterview,
        acceptAfterInterview,
        markNoShow,
        rejectCandidate,
    },
}));

const rescheduleInterviewByCommand = vi.fn();

// Справжній предикат причин — маппінг reasonCode перевіряється разом із ним.
vi.mock("../interview-reschedule-service.js", async () => {
    const actual = await vi.importActual<typeof import("../interview-reschedule-service.js")>(
        "../interview-reschedule-service.js",
    );
    return {
        isInterviewRescheduleReason: actual.isInterviewRescheduleReason,
        rescheduleInterviewByCommand,
    };
});

const findByTelegramId = vi.fn();
const candidateUpdate = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId, update: candidateUpdate },
}));

const findByCanonicalCode = vi.fn();

vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findByCanonicalCode },
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
    locationCode: null,
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
    acceptAfterInterview.mockResolvedValue(true);
    markNoShow.mockResolvedValue(true);
    rejectCandidate.mockResolvedValue(true);
    rescheduleInterviewByCommand.mockResolvedValue({ ok: true, delivered: true, slotsOffered: 3 });
    candidateUpdate.mockResolvedValue({});
    findByCanonicalCode.mockResolvedValue(null);
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

    it("ACCEPT_AFTER_INTERVIEW maps to acceptAfterInterview — the offer is sent at once", async () => {
        const api = makeApi();
        acceptAfterInterview.mockResolvedValue(true);
        listPending.mockResolvedValue({ items: [command({ kind: "ACCEPT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(acceptAfterInterview).toHaveBeenCalledWith(api, "cand-1", expect.any(String));
        expect(makeDecision).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e");
    });

    it("REJECT_AFTER_INTERVIEW maps to rejectAfterInterview — rejection is sent at once", async () => {
        const api = makeApi();
        rejectAfterInterview.mockResolvedValue(true);
        listPending.mockResolvedValue({ items: [command({ kind: "REJECT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(rejectAfterInterview).toHaveBeenCalledWith(api, "cand-1", expect.any(String));
        expect(makeDecision).not.toHaveBeenCalled();
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

    describe("RESCHEDULE_INTERVIEW (рішення власника 01.10.2026)", () => {
        it.each([
            ["CANDIDATE_ASKED"],
        ])("passes reasonCode %s to the reschedule service and acks applied", async (reasonCode) => {
            const api = makeApi();
            listPending.mockResolvedValue({
                items: [command({ kind: "RESCHEDULE_INTERVIEW", reasonCode })],
            });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(rescheduleInterviewByCommand).toHaveBeenCalledWith(api, "cand-1", reasonCode, { isRetry: false });
            expect(ackApplied).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e");
            expect(ackFailed).not.toHaveBeenCalled();
        });

        it("marks a repeated attempt as a retry so the service can resend a lost message", async () => {
            listPending.mockResolvedValue({
                items: [command({ kind: "RESCHEDULE_INTERVIEW", reasonCode: "CANDIDATE_ASKED", attempts: 1 })],
            });

            await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

            expect(rescheduleInterviewByCommand).toHaveBeenCalledWith(
                expect.anything(), "cand-1", "CANDIDATE_ASKED", { isRetry: true },
            );
        });

        it("fails with a ':state_conflict' suffix so the webapp stops retrying", async () => {
            rescheduleInterviewByCommand.mockResolvedValue({ ok: false, reason: "state_conflict" });
            listPending.mockResolvedValue({
                items: [command({ kind: "RESCHEDULE_INTERVIEW", reasonCode: "CANDIDATE_ASKED" })],
            });

            await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

            expect(ackFailed).toHaveBeenCalledWith(
                "0f8fad5b-d9cb-469f-a165-70867728950e",
                "RESCHEDULE_NOT_APPLIED:state_conflict",
            );
            expect(ackApplied).not.toHaveBeenCalled();
        });

        it("fails with RESCHEDULE_NOT_SENT:send_failed when Telegram refused the message", async () => {
            rescheduleInterviewByCommand.mockResolvedValue({ ok: false, reason: "send_failed" });
            listPending.mockResolvedValue({
                items: [command({ kind: "RESCHEDULE_INTERVIEW", reasonCode: "CANDIDATE_ASKED" })],
            });

            await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

            expect(ackFailed).toHaveBeenCalledWith(
                "0f8fad5b-d9cb-469f-a165-70867728950e",
                "RESCHEDULE_NOT_SENT:send_failed",
            );
        });

        it.each([
            ["SOMETHING_NEW", "RESCHEDULE_UNKNOWN_REASON:SOMETHING_NEW"],
            // Причину «зірвали ми» власник прибрав 01.10.2026.
            ["HR_MISSED", "RESCHEDULE_UNKNOWN_REASON:HR_MISSED"],
            [null, "RESCHEDULE_UNKNOWN_REASON:missing"],
        ])("refuses unknown reasonCode %s without touching the candidate", async (reasonCode, expected) => {
            listPending.mockResolvedValue({
                items: [command({ kind: "RESCHEDULE_INTERVIEW", reasonCode })],
            });

            await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

            expect(rescheduleInterviewByCommand).not.toHaveBeenCalled();
            expect(ackFailed).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e", expected);
        });
    });

    describe("CHANGE_LOCATION", () => {
        const PUBLIC_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
        const target = {
            id: "loc-new",
            canonicalCode: "zp-volkland-shevchyk",
            name: "Volkland",
            branch: "Шевчик",
            city: "Запоріжжя",
        };
        const screeningCandidate = {
            ...localCandidate,
            status: "SCREENING",
            currentStep: "INITIAL_TEST",
            locationId: "loc-old",
            city: "Київ",
        };
        const changeLocation = (overrides: Partial<Record<string, unknown>> = {}) =>
            command({ kind: "CHANGE_LOCATION", locationCode: target.canonicalCode, ...overrides });

        beforeEach(() => {
            findByTelegramId.mockResolvedValue(screeningCandidate);
            findByCanonicalCode.mockResolvedValue(target);
        });

        it("moves the candidate with her city, tells her on «ви», and acks applied", async () => {
            const api = makeApi();
            listPending.mockResolvedValue({ items: [changeLocation()] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(findByCanonicalCode).toHaveBeenCalledWith("zp-volkland-shevchyk");
            expect(candidateUpdate).toHaveBeenCalledWith("cand-1", {
                location: { connect: { id: "loc-new" } },
                city: "Запоріжжя",
            });
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
            const [tid, text, options] = api.sendMessage.mock.calls[0]!;
            expect(tid).toBe(1164289764);
            expect(text).toContain("Ваша нова локація — <b>Volkland (Шевчик), Запоріжжя</b>");
            expect(options).toEqual({ parse_mode: "HTML" });
            expect(ackApplied).toHaveBeenCalledWith(PUBLIC_ID);
            expect(ackFailed).not.toHaveBeenCalled();
        });

        it("speaks on «ти» to a candidate already past the HR decision", async () => {
            const api = makeApi();
            findByTelegramId.mockResolvedValue({ ...screeningCandidate, status: "STAGING_ACTIVE", currentStep: "FIRST_SHIFT" });
            listPending.mockResolvedValue({ items: [changeLocation()] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).toHaveBeenCalledTimes(1);
            expect(api.sendMessage.mock.calls[0]![1]).toContain("Твоя нова локація");
            expect(ackApplied).toHaveBeenCalledWith(PUBLIC_ID);
        });

        it("fails LOCATION_CHANGE_INVALID:missing_location without a code", async () => {
            const api = makeApi();
            listPending.mockResolvedValue({ items: [changeLocation({ locationCode: null })] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(findByCanonicalCode).not.toHaveBeenCalled();
            expect(candidateUpdate).not.toHaveBeenCalled();
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(ackFailed).toHaveBeenCalledWith(PUBLIC_ID, "LOCATION_CHANGE_INVALID:missing_location");
        });

        it("fails LOCATION_CHANGE_INVALID:location_not_found for an unknown code", async () => {
            const api = makeApi();
            findByCanonicalCode.mockResolvedValue(null);
            listPending.mockResolvedValue({ items: [changeLocation({ locationCode: "nowhere" })] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).not.toHaveBeenCalled();
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(ackFailed).toHaveBeenCalledWith(PUBLIC_ID, "LOCATION_CHANGE_INVALID:location_not_found");
        });

        it("refuses a rejected candidate instead of messaging her", async () => {
            const api = makeApi();
            findByTelegramId.mockResolvedValue({ ...screeningCandidate, status: "REJECTED" });
            listPending.mockResolvedValue({ items: [changeLocation()] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).not.toHaveBeenCalled();
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(ackFailed).toHaveBeenCalledWith(PUBLIC_ID, "LOCATION_CHANGE_INVALID:candidate_rejected");
        });

        it("acks applied silently on a first attempt when she is already there", async () => {
            const api = makeApi();
            findByTelegramId.mockResolvedValue({ ...screeningCandidate, locationId: "loc-new" });
            listPending.mockResolvedValue({ items: [changeLocation()] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).not.toHaveBeenCalled();
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(ackApplied).toHaveBeenCalledWith(PUBLIC_ID);
        });

        it("on a retry after a lost message re-sends it without writing the location again", async () => {
            const api = makeApi();
            findByTelegramId.mockResolvedValue({ ...screeningCandidate, locationId: "loc-new" });
            listPending.mockResolvedValue({ items: [changeLocation({ attempts: 1 })] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).not.toHaveBeenCalled();
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
            expect(ackApplied).toHaveBeenCalledWith(PUBLIC_ID);
        });

        it("fails LOCATION_CHANGED_NOT_SENT:send_failed when the location is written but Telegram refused", async () => {
            const api = makeApi();
            api.sendMessage.mockRejectedValue(new Error("Too Many Requests"));
            listPending.mockResolvedValue({ items: [changeLocation()] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).toHaveBeenCalledTimes(1);
            expect(ackApplied).not.toHaveBeenCalled();
            expect(ackFailed).toHaveBeenCalledWith(PUBLIC_ID, "LOCATION_CHANGED_NOT_SENT:send_failed");
        });

        it("fails LOCATION_CHANGED_NOT_SENT:bot_blocked on a 403", async () => {
            const api = makeApi();
            api.sendMessage.mockRejectedValue(Object.assign(new Error("Forbidden: bot was blocked by the user"), { error_code: 403 }));
            listPending.mockResolvedValue({ items: [changeLocation()] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(candidateUpdate).toHaveBeenCalledTimes(1);
            expect(ackFailed).toHaveBeenCalledWith(PUBLIC_ID, "LOCATION_CHANGED_NOT_SENT:bot_blocked");
        });
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
        acceptAfterInterview.mockRejectedValue(guardError);
        listPending.mockResolvedValue({ items: [command({ kind: "ACCEPT_AFTER_INTERVIEW" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("DECISION_ALREADY_MADE"),
        );
    });

    it("truncates a long error message before reporting it", async () => {
        acceptAfterInterview.mockRejectedValue(new Error("x".repeat(600)));
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
        acceptAfterInterview.mockRejectedValue(new Error("db down"));

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
