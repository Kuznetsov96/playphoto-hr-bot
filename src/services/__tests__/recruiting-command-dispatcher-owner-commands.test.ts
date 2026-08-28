import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner-команды полного цикла найма (фаза 3b). КРИТИЧЕСКАЯ семантика: владелец
 * общается с кандидаткой ЛИЧНО со своего Telegram-аккаунта, поэтому
 * MARK_TRAINING_PASSED / START_STAGING / MARK_STAGING_PASSED / CONFIRM_HIRE и
 * REJECT на ручных стадиях — НЕМЫЕ: ни одного сообщения кандидатке, никаких
 * уведомлений менторам/стейджингу. Команды только двигают воронку бота
 * последовательными легальными шагами через candidateRepository.update.
 */
const listPending = vi.fn();
const ackApplied = vi.fn();
const ackFailed = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        listPendingRecruitingCommands: listPending,
        ackRecruitingCommandApplied: ackApplied,
        ackRecruitingCommandFailed: ackFailed,
        listPendingRecruitingMessages: vi.fn().mockResolvedValue({ items: [] }),
        listPendingRecruitingBroadcasts: vi.fn().mockResolvedValue({ items: [], stages: [] }),
    },
}));

const rejectCandidate = vi.fn();
const confirmFinalSchedule = vi.fn();

vi.mock("../hr-service.js", () => ({
    hrService: {
        inviteCandidate: vi.fn(),
        makeDecision: vi.fn(),
        markNoShow: vi.fn(),
        rejectCandidate,
        confirmFinalSchedule,
    },
}));

const registerNewHire = vi.fn();

vi.mock("../team-registration-service.js", () => ({
    teamRegistrationService: { registerNewHire },
}));

const findByTelegramId = vi.fn();
const update = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId, update },
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
    kind: "MARK_TRAINING_PASSED",
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

const localCandidate = (status: string) => ({
    id: "cand-1",
    status,
    fullName: "Тестова Кандидатка",
    phone: "+380501112233",
    email: "cand@example.test",
    instagram: "candidate_ig",
    iban: "UA123456789012345678901234567",
    city: "Черкаси",
    birthDate: new Date("2003-05-01"),
    locationId: "loc-1",
    location: { id: "loc-1", name: "Fantasy Town", canonicalCode: "FT_CHERKASY" },
    user: { id: "user-1", telegramId: 1164289764n, username: "cand_user" },
});

/** Список статусов, которые репозиторий последовательно записал. */
const updatedStatuses = () => update.mock.calls.map(([, data]) => (data as { status?: string }).status);

beforeEach(() => {
    vi.clearAllMocks();
    redisSet.mockResolvedValue("OK");
    redisEval.mockResolvedValue(1);
    listPending.mockResolvedValue({ items: [] });
    ackApplied.mockResolvedValue({ publicId: "x", status: "APPLIED" });
    ackFailed.mockResolvedValue({ publicId: "x", status: "PENDING" });
    update.mockResolvedValue({});
    rejectCandidate.mockResolvedValue(true);
    registerNewHire.mockResolvedValue(true);
    confirmFinalSchedule.mockResolvedValue({ candidate: { status: "HIRED" }, mentorId: null, candidateId: 1164289764 });
});

afterEach(() => vi.restoreAllMocks());

describe("RecruitingCommandDispatcher: немые owner-команды", () => {
    it("MARK_TRAINING_PASSED из MENTOR_MANUAL — один немой шаг в TRAINING_COMPLETED", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("MENTOR_MANUAL"));
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_TRAINING_PASSED" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(updatedStatuses()).toEqual(["TRAINING_COMPLETED"]);
        expect(update).toHaveBeenCalledWith("cand-1", { status: "TRAINING_COMPLETED" });
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalledWith("0f8fad5b-d9cb-469f-a165-70867728950e");
        expect(ackFailed).not.toHaveBeenCalled();
    });

    it("MARK_TRAINING_PASSED идемпотентен: кандидатка уже TRAINING_COMPLETED — без записи, ack applied", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("TRAINING_COMPLETED"));
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_TRAINING_PASSED" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(update).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalled();
    });

    it("START_STAGING из MENTOR_MANUAL — немой путь TRAINING_COMPLETED → STAGING_SETUP → STAGING_ACTIVE", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("MENTOR_MANUAL"));
        listPending.mockResolvedValue({ items: [command({ kind: "START_STAGING" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(updatedStatuses()).toEqual(["TRAINING_COMPLETED", "STAGING_SETUP", "STAGING_ACTIVE"]);
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalled();
    });

    it("START_STAGING из STAGING_SETUP — один шаг в STAGING_ACTIVE", async () => {
        findByTelegramId.mockResolvedValue(localCandidate("STAGING_SETUP"));
        listPending.mockResolvedValue({ items: [command({ kind: "START_STAGING" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(updatedStatuses()).toEqual(["STAGING_ACTIVE"]);
        expect(ackApplied).toHaveBeenCalled();
    });

    it("MARK_STAGING_PASSED из STAGING_ACTIVE — немой шаг в READY_FOR_HIRE, без промпта о документах", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("STAGING_ACTIVE"));
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_STAGING_PASSED" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(updatedStatuses()).toEqual(["READY_FOR_HIRE"]);
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalled();
    });

    it("MARK_STAGING_PASSED из STAGING_SETUP — через STAGING_ACTIVE", async () => {
        findByTelegramId.mockResolvedValue(localCandidate("STAGING_SETUP"));
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_STAGING_PASSED" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(updatedStatuses()).toEqual(["STAGING_ACTIVE", "READY_FOR_HIRE"]);
    });

    it("CONFIRM_HIRE — registerNewHire (Employee в вебаппе) + confirmFinalSchedule, ни одного сообщения кандидатке", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("READY_FOR_HIRE"));
        listPending.mockResolvedValue({ items: [command({ kind: "CONFIRM_HIRE" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(registerNewHire).toHaveBeenCalledWith(expect.objectContaining({
            telegramId: "1164289764",
            fullName: "Тестова Кандидатка",
            locationCode: "FT_CHERKASY",
        }));
        expect(confirmFinalSchedule).toHaveBeenCalledWith("cand-1");
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalled();
        expect(ackFailed).not.toHaveBeenCalled();
    });

    it("CONFIRM_HIRE: сбой registerNewHire — failed-ack, статус не трогается", async () => {
        findByTelegramId.mockResolvedValue(localCandidate("READY_FOR_HIRE"));
        registerNewHire.mockRejectedValue(new Error("Candidate location is not mapped to an AWS canonical location code"));
        listPending.mockResolvedValue({ items: [command({ kind: "CONFIRM_HIRE" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(confirmFinalSchedule).not.toHaveBeenCalled();
        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("not mapped"),
        );
        expect(ackApplied).not.toHaveBeenCalled();
    });

    it("REJECT на ручной стадии (MENTOR_MANUAL) — немой перевод в REJECTED с hrDecision, без rejectCandidate", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("MENTOR_MANUAL"));
        listPending.mockResolvedValue({ items: [command({ kind: "REJECT" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(update).toHaveBeenCalledWith("cand-1", { status: "REJECTED", hrDecision: "REJECTED" });
        expect(rejectCandidate).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalled();
    });

    it.each([["STAGING_ACTIVE"], ["READY_FOR_HIRE"], ["AWAITING_FIRST_SHIFT"], ["NDA"], ["TRAINING_SCHEDULED"], ["DISCOVERY_COMPLETED"]])(
        "REJECT на ручной стадии %s — тоже немой",
        async (status) => {
            const api = makeApi();
            findByTelegramId.mockResolvedValue(localCandidate(status));
            listPending.mockResolvedValue({ items: [command({ kind: "REJECT" })] });

            await new RecruitingCommandDispatcher().runOnce(api as never);

            expect(rejectCandidate).not.toHaveBeenCalled();
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(update).toHaveBeenCalledWith("cand-1", { status: "REJECTED", hrDecision: "REJECTED" });
        },
    );

    it("REJECT до интервью (SCREENING) — прежний путь rejectCandidate с сообщением GENERAL", async () => {
        const api = makeApi();
        findByTelegramId.mockResolvedValue(localCandidate("SCREENING"));
        listPending.mockResolvedValue({ items: [command({ kind: "REJECT" })] });

        await new RecruitingCommandDispatcher().runOnce(api as never);

        expect(rejectCandidate).toHaveBeenCalledWith(api, "cand-1", "GENERAL");
        expect(update).not.toHaveBeenCalled();
        expect(ackApplied).toHaveBeenCalled();
    });

    it("невозможный путь воронки — failed-ack с кодом гарда", async () => {
        findByTelegramId.mockResolvedValue(localCandidate("MENTOR_MANUAL"));
        update.mockRejectedValue(Object.assign(new Error("Transition MENTOR_MANUAL -> TRAINING_COMPLETED is not allowed"), {
            reasonCode: "INVALID_STATUS_TRANSITION",
        }));
        listPending.mockResolvedValue({ items: [command({ kind: "MARK_TRAINING_PASSED" })] });

        await new RecruitingCommandDispatcher().runOnce(makeApi() as never);

        expect(ackFailed).toHaveBeenCalledWith(
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            expect.stringContaining("INVALID_STATUS_TRANSITION"),
        );
        expect(ackApplied).not.toHaveBeenCalled();
    });
});
