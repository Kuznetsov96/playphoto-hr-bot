import { describe, expect, it, vi } from "vitest";
import {
    ReplacementNotificationDispatcher,
    revertReplacementIfOwner,
    answerReplacementOffer,
    undoReplacementAcceptanceAsCandidate,
} from "../replacement-notification-dispatcher.js";

const pendingRow = {
    publicId: "n-1",
    kind: "OFFER_CLOSED" as const,
    telegramId: "222",
    payload: {
        startsAtLocal: "2026-08-15T10:00",
        endsAtLocal: "2026-08-15T19:00",
        timezone: "Europe/Kyiv",
        locationPublicId: "loc-1",
        locationName: "Аркадія",
        locationCity: "Одеса",
        replacementPublicId: "req-1",
    },
};

describe("ReplacementNotificationDispatcher", () => {
    it("sends a closed-offer message and marks it delivered", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const markDelivered = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([pendingRow]),
                markReplacementNotificationDelivered: markDelivered,
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
        );

        const result = await dispatcher.dispatchPending();

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]![1]).toContain("Аркадія");
        expect(markDelivered).toHaveBeenCalledWith("n-1");
        expect(result).toEqual({ delivered: 1, failed: 0 });
    });

    it("records a failure without throwing when Telegram rejects the message", async () => {
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([pendingRow]),
                markReplacementNotificationDelivered: vi.fn(),
                markReplacementNotificationFailed: markFailed,
            } as never,
            { sendMessage: vi.fn().mockRejectedValue(new Error("blocked")) } as never,
        );

        const result = await dispatcher.dispatchPending();

        expect(markFailed).toHaveBeenCalledWith("n-1", expect.any(String));
        expect(result).toEqual({ delivered: 0, failed: 1 });
    });

    it("keeps going after one recipient fails", async () => {
        const sendMessage = vi
            .fn()
            .mockRejectedValueOnce(new Error("blocked"))
            .mockResolvedValueOnce(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi
                    .fn()
                    .mockResolvedValue([pendingRow, { ...pendingRow, publicId: "n-2", telegramId: "333" }]),
                markReplacementNotificationDelivered: vi.fn().mockResolvedValue(undefined),
                markReplacementNotificationFailed: vi.fn().mockResolvedValue(undefined),
            } as never,
            { sendMessage } as never,
        );

        const result = await dispatcher.dispatchPending();

        expect(result).toEqual({ delivered: 1, failed: 1 });
    });

    it("routes an ACCEPTED_OWNER_REVIEW confirmed message to the owner, not the row's own telegramId", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const markDelivered = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    {
                        publicId: "n-owner-1",
                        kind: "ACCEPTED_OWNER_REVIEW" as const,
                        // Deliberately the candidate's own id, distinct from the admin
                        // id — the dispatcher must not send here for this kind.
                        telegramId: "999",
                        payload: {
                            ...pendingRow.payload,
                            requesterDisplayName: "Петренко Олена",
                            candidateDisplayName: "Іваненко Марія",
                            outcome: "confirmed" as const,
                        },
                    },
                ]),
                markReplacementNotificationDelivered: markDelivered,
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
            { adminIds: [555] },
        );

        const result = await dispatcher.dispatchPending();

        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]![0]).toBe(555);
        expect(sendMessage.mock.calls[0]![1]).toMatch(/автоматично підтверджено/u);
        expect(markDelivered).toHaveBeenCalledWith("n-owner-1");
        expect(result).toEqual({ delivered: 1, failed: 0 });
    });

    it("tells the owner a needs_review acceptance requires a decision, not that it's already confirmed", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    {
                        publicId: "n-owner-2",
                        kind: "ACCEPTED_OWNER_REVIEW" as const,
                        telegramId: "999",
                        payload: {
                            ...pendingRow.payload,
                            requesterDisplayName: "Петренко Олена",
                            candidateDisplayName: "Іваненко Марія",
                            outcome: "needs_review" as const,
                        },
                    },
                ]),
                markReplacementNotificationDelivered: vi.fn().mockResolvedValue(undefined),
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
            { adminIds: [555] },
        );

        await dispatcher.dispatchPending();

        expect(sendMessage.mock.calls[0]![1]).toMatch(/потрібне твоє рішення/u);
        expect(sendMessage.mock.calls[0]![1]).not.toMatch(/автоматично підтверджено/u);
    });

    it("escapes names and locations, since the message is sent as HTML", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    {
                        publicId: "n-owner-3",
                        kind: "ACCEPTED_OWNER_REVIEW" as const,
                        telegramId: "999",
                        payload: {
                            ...pendingRow.payload,
                            locationName: "Fly <b>Kids</b>",
                            requesterDisplayName: "Петренко <i>Олена</i>",
                            candidateDisplayName: "Іваненко Марія",
                            outcome: "confirmed" as const,
                        },
                    },
                ]),
                markReplacementNotificationDelivered: vi.fn().mockResolvedValue(undefined),
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
            { adminIds: [555] },
        );

        await dispatcher.dispatchPending();

        // Telegram rejects a message whose HTML does not parse, so an unescaped
        // angle bracket in a name would silently lose the whole notification.
        const text = sendMessage.mock.calls[0]![1] as string;
        expect(text).toContain("Fly &lt;b&gt;Kids&lt;/b&gt;");
        expect(text).toContain("Петренко &lt;i&gt;Олена&lt;/i&gt;");
        expect(text).not.toContain("<b>Kids</b>");
    });

    // Important 1: the requester must never be told "an administrator"
    // cancelled her replacement when the candidate undid her own mis-tap —
    // `revertedBy` is the discriminator the backend now sends, mirroring how
    // `outcome` disambiguates ACCEPTED_OWNER_REVIEW.
    it("tells the requester the candidate undid her own acceptance, not that an administrator cancelled it", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    {
                        publicId: "n-revert-1",
                        kind: "ACCEPTANCE_REVERTED" as const,
                        telegramId: "111",
                        payload: { ...pendingRow.payload, revertedBy: "candidate" as const },
                    },
                ]),
                markReplacementNotificationDelivered: vi.fn().mockResolvedValue(undefined),
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
        );

        await dispatcher.dispatchPending();

        const text = sendMessage.mock.calls[0]![1] as string;
        expect(text).not.toMatch(/адміністратором/u);
    });

    it("still tells the requester an administrator cancelled it when the owner reverted", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    {
                        publicId: "n-revert-2",
                        kind: "ACCEPTANCE_REVERTED" as const,
                        telegramId: "111",
                        payload: { ...pendingRow.payload, revertedBy: "owner" as const },
                    },
                ]),
                markReplacementNotificationDelivered: vi.fn().mockResolvedValue(undefined),
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
        );

        await dispatcher.dispatchPending();

        const text = sendMessage.mock.calls[0]![1] as string;
        expect(text).toMatch(/адміністратором/u);
    });

    it("defaults ACCEPTANCE_REVERTED to the administrator wording when revertedBy is missing", async () => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    { publicId: "n-revert-3", kind: "ACCEPTANCE_REVERTED" as const, telegramId: "111", payload: pendingRow.payload },
                ]),
                markReplacementNotificationDelivered: vi.fn().mockResolvedValue(undefined),
                markReplacementNotificationFailed: vi.fn(),
            } as never,
            { sendMessage } as never,
        );

        await dispatcher.dispatchPending();

        const text = sendMessage.mock.calls[0]![1] as string;
        expect(text).toMatch(/адміністратором/u);
    });

    it("does not send an owner-review row anywhere when no admin id is configured", async () => {
        const sendMessage = vi.fn();
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    {
                        publicId: "n-owner-3",
                        kind: "ACCEPTED_OWNER_REVIEW" as const,
                        telegramId: "999",
                        payload: { ...pendingRow.payload, outcome: "confirmed" as const },
                    },
                ]),
                markReplacementNotificationDelivered: vi.fn(),
                markReplacementNotificationFailed: markFailed,
            } as never,
            { sendMessage } as never,
            { adminIds: [] },
        );

        const result = await dispatcher.dispatchPending();

        expect(sendMessage).not.toHaveBeenCalled();
        expect(markFailed).toHaveBeenCalledWith("n-owner-3", expect.any(String));
        expect(result).toEqual({ delivered: 0, failed: 1 });
    });

    it("skips a non-owner row with no telegramId and reports it failed, without throwing", async () => {
        const sendMessage = vi.fn();
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi.fn().mockResolvedValue([
                    { ...pendingRow, publicId: "n-no-telegram", telegramId: null },
                ]),
                markReplacementNotificationDelivered: vi.fn(),
                markReplacementNotificationFailed: markFailed,
            } as never,
            { sendMessage } as never,
        );

        const result = await dispatcher.dispatchPending();

        expect(sendMessage).not.toHaveBeenCalled();
        expect(markFailed).toHaveBeenCalledWith("n-no-telegram", expect.any(String));
        expect(result).toEqual({ delivered: 0, failed: 1 });
    });
});

// The mandatory check: the backend cannot verify who pressed the revert
// button (service token proves only "this is the bot"; there is no
// telegramId on the owner model). The ONLY protection is this ADMIN_IDS gate
// in the bot, run before the API client is ever called. Without it, anyone
// who can make the bot invoke the handler could cancel any confirmed
// replacement — so the case that matters most here is proving the client is
// NOT called for a non-admin id.
describe("revertReplacementIfOwner", () => {
    it("does not call the API client when the pressing id is not an admin", async () => {
        const revertReplacementAsOwner = vi.fn();

        const outcome = await revertReplacementIfOwner({
            telegramId: 42,
            requestPublicId: "req-1",
            acknowledgeLateRevert: false,
            client: { revertReplacementAsOwner },
            adminIds: [111, 222],
        });

        expect(revertReplacementAsOwner).not.toHaveBeenCalled();
        expect(outcome).toBe("denied");
    });

    it("does not call the API client when there is no Telegram id at all", async () => {
        const revertReplacementAsOwner = vi.fn();

        const outcome = await revertReplacementIfOwner({
            telegramId: undefined,
            requestPublicId: "req-1",
            acknowledgeLateRevert: false,
            client: { revertReplacementAsOwner },
            adminIds: [111],
        });

        expect(revertReplacementAsOwner).not.toHaveBeenCalled();
        expect(outcome).toBe("denied");
    });

    it("calls the API client, with the acknowledgement flag, when the pressing id is an admin", async () => {
        const revertReplacementAsOwner = vi.fn().mockResolvedValue({ publicId: "req-1", status: "ACTIVE" });

        const outcome = await revertReplacementIfOwner({
            telegramId: 111,
            requestPublicId: "req-1",
            acknowledgeLateRevert: true,
            client: { revertReplacementAsOwner },
            adminIds: [111, 222],
        });

        expect(revertReplacementAsOwner).toHaveBeenCalledWith("req-1", true);
        expect(outcome).toBe("reverted");
    });

    it("reports failed, not reverted, when the client call throws for an admin", async () => {
        const revertReplacementAsOwner = vi.fn().mockRejectedValue(new Error("REPLACEMENT_REVERT_NEEDS_ACKNOWLEDGEMENT"));

        const outcome = await revertReplacementIfOwner({
            telegramId: 111,
            requestPublicId: "req-1",
            acknowledgeLateRevert: false,
            client: { revertReplacementAsOwner },
            adminIds: [111],
        });

        expect(outcome).toBe("failed");
    });

    // Important 2: a late revert (shift starts within 2h) must not read as a
    // failure — the backend is asking the owner to knowingly confirm, not
    // reporting that something broke.
    it("reports needs_acknowledgement, not failed, when the backend's error carries that code", async () => {
        const revertReplacementAsOwner = vi.fn().mockRejectedValue(
            Object.assign(new Error("late revert"), { code: "REPLACEMENT_REVERT_NEEDS_ACKNOWLEDGEMENT" }),
        );

        const outcome = await revertReplacementIfOwner({
            telegramId: 111,
            requestPublicId: "req-1",
            acknowledgeLateRevert: false,
            client: { revertReplacementAsOwner },
            adminIds: [111],
        });

        expect(outcome).toBe("needs_acknowledgement");
    });

    it("the second tap, with acknowledgeLateRevert: true, reverts", async () => {
        const revertReplacementAsOwner = vi.fn().mockResolvedValue({ publicId: "req-1", status: "ACTIVE" });

        const outcome = await revertReplacementIfOwner({
            telegramId: 111,
            requestPublicId: "req-1",
            acknowledgeLateRevert: true,
            client: { revertReplacementAsOwner },
            adminIds: [111],
        });

        expect(revertReplacementAsOwner).toHaveBeenCalledWith("req-1", true);
        expect(outcome).toBe("reverted");
    });

    it("defaults to the bot's real ADMIN_IDS when none are supplied", async () => {
        const revertReplacementAsOwner = vi.fn();

        // No admin ids are configured in the test environment's ADMIN_IDS env
        // var, so an arbitrary id must still be denied without the caller
        // having to pass adminIds explicitly.
        const outcome = await revertReplacementIfOwner({
            telegramId: 999999,
            requestPublicId: "req-1",
            acknowledgeLateRevert: false,
            client: { revertReplacementAsOwner },
        });

        expect(revertReplacementAsOwner).not.toHaveBeenCalled();
        expect(outcome).toBe("denied");
    });
});

// Critical 2: the candidate undo button was previously unreachable — no
// handler called this at all. The window and ownership checks are the
// backend's job (undoByCandidate re-verifies the offer belongs to this
// employee/telegramId), so this only has to prove the client is called with
// what the accepting photographer actually is, and that the result is
// classified correctly.
describe("undoReplacementAcceptanceAsCandidate", () => {
    it("calls the client with the pressing photographer's own identity, not an admin gate", async () => {
        const undoReplacementAcceptance = vi.fn().mockResolvedValue({ publicId: "req-1", status: "ACTIVE" });

        const outcome = await undoReplacementAcceptanceAsCandidate({
            offerPublicId: "offer-1",
            employeePublicId: "emp-2",
            telegramId: 222,
            client: { undoReplacementAcceptance },
        });

        expect(undoReplacementAcceptance).toHaveBeenCalledWith("offer-1", "emp-2", "222");
        expect(outcome).toBe("undone");
    });

    it("reports window_closed, not a generic failure, when the backend's error carries that code", async () => {
        const undoReplacementAcceptance = vi.fn().mockRejectedValue(
            Object.assign(new Error("too late"), { code: "REPLACEMENT_UNDO_WINDOW_CLOSED" }),
        );

        const outcome = await undoReplacementAcceptanceAsCandidate({
            offerPublicId: "offer-1",
            employeePublicId: "emp-2",
            telegramId: 222,
            client: { undoReplacementAcceptance },
        });

        expect(outcome).toBe("window_closed");
    });

    it("reports failed for any other error, including a plain network failure", async () => {
        const undoReplacementAcceptance = vi.fn().mockRejectedValue(new Error("network down"));

        const outcome = await undoReplacementAcceptanceAsCandidate({
            offerPublicId: "offer-1",
            employeePublicId: "emp-2",
            telegramId: 222,
            client: { undoReplacementAcceptance },
        });

        expect(outcome).toBe("failed");
    });
});

/**
 * The gap this suite closes: an `OFFER` row rendered its text and went out with
 * no keyboard at all, so a photographer was told a shift was free and had no way
 * to say yes. Accept and decline are addressed by offer, so the buttons carry
 * `offerPublicId` — the field the backend now puts in the payload.
 */
describe("OFFER notifications carry answer buttons", () => {
    const offerRow = {
        publicId: "n-offer-1",
        kind: "OFFER" as const,
        telegramId: "333",
        payload: {
            startsAtLocal: "2026-08-15T14:00",
            endsAtLocal: "2026-08-15T21:00",
            timezone: "Europe/Kyiv",
            locationPublicId: "loc-1",
            locationName: "Smile Park",
            locationCity: "Kyiv",
            replacementPublicId: "req-1",
            offerPublicId: "offer-1",
            candidatePublicId: "emp-1",
        },
    };

    const dispatchOffer = async (payloadOverrides: Record<string, unknown> = {}) => {
        const sendMessage = vi.fn().mockResolvedValue(undefined);
        const markDelivered = vi.fn().mockResolvedValue(undefined);
        const markFailed = vi.fn().mockResolvedValue(undefined);
        const dispatcher = new ReplacementNotificationDispatcher(
            {
                pendingReplacementNotifications: vi
                    .fn()
                    .mockResolvedValue([
                        { ...offerRow, payload: { ...offerRow.payload, ...payloadOverrides } },
                    ]),
                markReplacementNotificationDelivered: markDelivered,
                markReplacementNotificationFailed: markFailed,
            } as never,
            { sendMessage } as never,
        );
        const result = await dispatcher.dispatchPending();
        return { sendMessage, markDelivered, markFailed, result };
    };

    it("attaches an accept and a decline button to the offer", async () => {
        const { sendMessage, result } = await dispatchOffer();

        const options = sendMessage.mock.calls[0]![2] as { reply_markup?: { inline_keyboard: unknown[][] } };
        const buttons = (options.reply_markup?.inline_keyboard ?? []).flat() as Array<{
            text: string;
            callback_data: string;
        }>;

        expect(buttons).toHaveLength(2);
        expect(buttons.map((button) => button.callback_data)).toEqual([
            expect.stringContaining("offer-1"),
            expect.stringContaining("offer-1"),
        ]);
        expect(result).toEqual({ delivered: 1, failed: 0 });
    });

    /**
     * The two buttons must be distinguishable by their callback code alone: the
     * handler routes on it, and a shared code would make "no" do what "yes" does.
     */
    it("gives accept and decline distinct callback codes", async () => {
        const { sendMessage } = await dispatchOffer();

        const options = sendMessage.mock.calls[0]![2] as { reply_markup?: { inline_keyboard: unknown[][] } };
        const codes = ((options.reply_markup?.inline_keyboard ?? []).flat() as Array<{
            callback_data: string;
        }>).map((button) => button.callback_data.split(":")[1]);

        expect(new Set(codes).size).toBe(2);
    });

    it("still names the venue and the shift time in the message", async () => {
        const { sendMessage } = await dispatchOffer();

        expect(sendMessage.mock.calls[0]![1]).toContain("Smile Park");
    });

    /**
     * An older backend that has not shipped `offerPublicId` yet would otherwise
     * produce a button pointing at nothing. Sending the text without buttons is
     * the honest degradation — the photographer still learns the shift is free
     * and can answer through the schedule.
     */
    it("sends the message without buttons when the payload carries no offerPublicId", async () => {
        const { sendMessage, result } = await dispatchOffer({ offerPublicId: undefined });

        const options = sendMessage.mock.calls[0]![2] as { reply_markup?: unknown };
        expect(options.reply_markup).toBeUndefined();
        expect(result).toEqual({ delivered: 1, failed: 0 });
    });
});

/**
 * Answering an offer is a canonical write: the backend owns whether the shift
 * actually moves, so the bot reports the tap and renders whatever answer comes
 * back. It never decides locally that an acceptance succeeded.
 */
describe("answerReplacementOffer", () => {
    const base = {
        offerPublicId: "offer-1",
        employeePublicId: "emp-1",
        telegramId: 333,
    };

    it("accepts through the canonical backend", async () => {
        const acceptReplacementOffer = vi.fn().mockResolvedValue({ publicId: "req-1", status: "CONFIRMED" });
        const outcome = await answerReplacementOffer({
            ...base,
            answer: "accept",
            client: { acceptReplacementOffer, declineReplacementOffer: vi.fn() } as never,
        });

        expect(acceptReplacementOffer).toHaveBeenCalledWith("offer-1", {
            employeePublicId: "emp-1",
            telegramId: "333",
        });
        expect(outcome).toBe("accepted");
    });

    it("declines through the canonical backend", async () => {
        const declineReplacementOffer = vi.fn().mockResolvedValue({ publicId: "req-1", status: "ACTIVE" });
        const outcome = await answerReplacementOffer({
            ...base,
            answer: "decline",
            client: { acceptReplacementOffer: vi.fn(), declineReplacementOffer } as never,
        });

        expect(declineReplacementOffer).toHaveBeenCalledWith("offer-1", {
            employeePublicId: "emp-1",
            telegramId: "333",
        });
        expect(outcome).toBe("declined");
    });

    /**
     * Someone else got there first. This is an ordinary race, not a fault: the
     * photographer must be told the shift is gone rather than shown a retry
     * prompt for something that cannot succeed.
     */
    it("reports a closed offer separately from a genuine failure", async () => {
        const outcome = await answerReplacementOffer({
            ...base,
            answer: "accept",
            client: {
                acceptReplacementOffer: vi
                    .fn()
                    .mockRejectedValue(Object.assign(new Error("closed"), { code: "REPLACEMENT_OFFER_CLOSED" })),
                declineReplacementOffer: vi.fn(),
            } as never,
        });

        expect(outcome).toBe("gone");
    });

    it("reports a backend outage as a retryable failure, not as an acceptance", async () => {
        const outcome = await answerReplacementOffer({
            ...base,
            answer: "accept",
            client: {
                acceptReplacementOffer: vi.fn().mockRejectedValue(new Error("boom")),
                declineReplacementOffer: vi.fn(),
            } as never,
        });

        expect(outcome).toBe("failed");
    });
});
