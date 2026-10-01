import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";

/**
 * Перенос співбесіди командою вебаппа (рішення власника 01.10.2026):
 * звільнення слота (спершу вебапп, потім локально), легальний шлях воронки
 * до «шукає час», погоджені тексти й та сама клавіатура слотів, що в
 * «Обрати час».
 */
const calls: string[] = [];

const findById = vi.fn();
const update = vi.fn();
const requestMirrorPush = vi.fn();
vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findById, update, requestMirrorPush },
}));

const tx = { marker: "tx" };
vi.mock("../../db/core.js", () => ({
    default: { $transaction: (fn: (client: unknown) => Promise<unknown>) => fn(tx) },
}));

const cancelInterviewSlot = vi.fn();
vi.mock("../booking-service.js", () => ({ bookingService: { cancelInterviewSlot } }));

const findAvailableInterviewSlots = vi.fn();
const releaseCanonicalInterviewSlot = vi.fn();
vi.mock("../canonical-interview-slots.js", () => ({
    findAvailableInterviewSlots,
    releaseCanonicalInterviewSlot,
}));

const cleanupUserSessionMessages = vi.fn();
const trackUserMessage = vi.fn();
vi.mock("../../utils/cleanup.js", () => ({ cleanupUserSessionMessages, trackUserMessage }));

const handleBlockedCandidate = vi.fn();
vi.mock("../../utils/bot-blocked.js", async () => {
    const actual = await vi.importActual<typeof import("../../utils/bot-blocked.js")>("../../utils/bot-blocked.js");
    return { isBotBlocked: actual.isBotBlocked, handleBlockedCandidate };
});

vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { rescheduleInterviewByCommand } = await import("../interview-reschedule-service.js");
const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");

const TID = 1164289764;
const slots = [
    { id: "slot-a", startTime: new Date("2026-10-03T07:00:00Z") },
    { id: "slot-b", startTime: new Date("2026-10-03T08:00:00Z") },
];

const candidate = (overrides: Record<string, unknown> = {}) => ({
    id: "cand-1",
    fullName: "Олена",
    status: CandidateStatus.INTERVIEW_SCHEDULED,
    currentStep: FunnelStep.INTERVIEW,
    hrDecision: null,
    interviewSlotId: "local-slot-1",
    user: { id: "user-1", telegramId: BigInt(TID) },
    ...overrides,
});

const makeApi = () => ({
    sendMessage: vi.fn(async () => {
        calls.push("send");
        return { message_id: 42 };
    }),
});

function callbacks(markup: { inline_keyboard: Array<Array<{ callback_data?: string }>> }): string[] {
    return markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
}

beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    findById.mockResolvedValue(candidate());
    update.mockImplementation(async (_id: string, data: { status?: string }) => {
        calls.push(`update:${data.status ?? "-"}`);
        return {};
    });
    findAvailableInterviewSlots.mockResolvedValue(slots);
    releaseCanonicalInterviewSlot.mockImplementation(async () => { calls.push("release"); });
    cancelInterviewSlot.mockImplementation(async () => { calls.push("cancel"); });
    cleanupUserSessionMessages.mockImplementation(async () => { calls.push("cleanup"); });
    trackUserMessage.mockResolvedValue(undefined);
});

describe("rescheduleInterviewByCommand", () => {
    it("releases in the webapp first, then locally, then moves the funnel, then writes", async () => {
        const api = makeApi();

        const result = await rescheduleInterviewByCommand(api as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(result).toEqual({ ok: true, delivered: true, slotsOffered: 2 });
        expect(calls).toEqual([
            "release",
            "cancel",
            `update:${CandidateStatus.WAITLIST_HR}`,
            `update:${CandidateStatus.SCREENING}`,
            "cleanup",
            "send",
        ]);
        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(TID, "candidate_asked_reschedule");
        expect(cancelInterviewSlot).toHaveBeenCalledWith("local-slot-1");
    });

    it("moves INTERVIEW_* → WAITLIST_HR → SCREENING in one transaction, as a fresh invitation", async () => {
        await rescheduleInterviewByCommand(makeApi() as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(update).toHaveBeenNthCalledWith(1, "cand-1", {
            status: CandidateStatus.WAITLIST_HR,
            currentStep: FunnelStep.INTERVIEW,
            interviewCompletedAt: null,
        }, tx);
        expect(update).toHaveBeenNthCalledWith(2, "cand-1", expect.objectContaining({
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INTERVIEW,
            notificationSent: true,
            isWaitlisted: false,
            interviewInvitedAt: expect.any(Date),
            interviewInviteReminderSentAt: null,
        }), tx);
        expect(releaseCanonicalInterviewSlot).toHaveBeenCalledWith(TID, "candidate_asked_reschedule");
    });

    it.each([
        ["CANDIDATE_ASKED", "<b>Перенесемо співбесіду</b>\n\nОберіть, будь ласка, інший зручний час:"],
    ] as const)("sends the agreed %s text with the start_scheduling slot keyboard", async (reason, text) => {
        const api = makeApi();

        await rescheduleInterviewByCommand(api as never, "cand-1", reason, { isRetry: false });

        const [tid, sent, options] = api.sendMessage.mock.calls[0] as unknown as [number, string, { parse_mode: string; reply_markup: never }];
        expect(tid).toBe(TID);
        expect(sent).toBe(text);
        expect(options.parse_mode).toBe("HTML");
        expect(callbacks(options.reply_markup)).toEqual(["book_slot_slot-a", "book_slot_slot-b", "no_slots_fit"]);
        expect(trackUserMessage).toHaveBeenCalledWith(TID, 42);
    });

    it("also reschedules an auto-completed interview without an HR decision", async () => {
        findById.mockResolvedValue(candidate({ status: CandidateStatus.INTERVIEW_COMPLETED }));

        const result = await rescheduleInterviewByCommand(makeApi() as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(result.ok).toBe(true);
    });

    it("without free slots queues her like «Обрати час» does and sends the no-slots text", async () => {
        findAvailableInterviewSlots.mockResolvedValue([]);
        const api = makeApi();

        await rescheduleInterviewByCommand(api as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(update).toHaveBeenNthCalledWith(2, "cand-1", expect.objectContaining({
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INTERVIEW,
            notificationSent: false,
            interviewWaitlistReason: "NO_SLOTS_AVAILABLE",
            noSlotsAt: expect.any(Date),
            interviewInvitedAt: null,
        }), tx);
        const [, sent, options] = api.sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: never }];
        expect(sent).toBe(CANDIDATE_TEXTS["candidate-interview-reschedule-asked-no-slots"]);
        expect(callbacks(options.reply_markup)).toEqual(["contact_hr"]);
    });

    it.each([
        ["an HR decision is already made", { status: CandidateStatus.INTERVIEW_COMPLETED, hrDecision: "ACCEPTED" }],
        ["she is not in the interview stage", { status: CandidateStatus.REJECTED }],
        ["she already looks for time but this is the first attempt", { status: CandidateStatus.SCREENING, interviewSlotId: null }],
    ])("returns state_conflict and touches nothing when %s", async (_label, overrides) => {
        findById.mockResolvedValue(candidate(overrides));
        const api = makeApi();

        const result = await rescheduleInterviewByCommand(api as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(result).toEqual({ ok: false, reason: "state_conflict" });
        expect(releaseCanonicalInterviewSlot).not.toHaveBeenCalled();
        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(requestMirrorPush).toHaveBeenCalledWith("cand-1");
    });

    it("on retry after a lost message only resends: no second release, no WAITLIST_HR step", async () => {
        findById.mockResolvedValue(candidate({ status: CandidateStatus.SCREENING, interviewSlotId: null }));
        const api = makeApi();

        const result = await rescheduleInterviewByCommand(api as never, "cand-1", "CANDIDATE_ASKED", { isRetry: true });

        expect(result.ok).toBe(true);
        expect(releaseCanonicalInterviewSlot).not.toHaveBeenCalled();
        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledTimes(1);
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not move the funnel when the webapp release fails", async () => {
        releaseCanonicalInterviewSlot.mockRejectedValue(new Error("RECRUITING_API_DOWN"));

        await expect(
            rescheduleInterviewByCommand(makeApi() as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false }),
        ).rejects.toThrow("RECRUITING_API_DOWN");
        expect(cancelInterviewSlot).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("archives a candidate who blocked the bot and still reports the command applied", async () => {
        const api = makeApi();
        api.sendMessage.mockRejectedValue(Object.assign(new Error("Forbidden: bot was blocked by the user"), { error_code: 403 }));

        const result = await rescheduleInterviewByCommand(api as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(result).toEqual({ ok: true, delivered: false, slotsOffered: 2 });
        expect(handleBlockedCandidate).toHaveBeenCalledWith(api, "cand-1", "Олена");
    });

    it("reports send_failed for any other delivery error", async () => {
        const api = makeApi();
        api.sendMessage.mockRejectedValue(new Error("Too Many Requests"));

        const result = await rescheduleInterviewByCommand(api as never, "cand-1", "CANDIDATE_ASKED", { isRetry: false });

        expect(result).toEqual({ ok: false, reason: "send_failed" });
        expect(handleBlockedCandidate).not.toHaveBeenCalled();
    });
});
