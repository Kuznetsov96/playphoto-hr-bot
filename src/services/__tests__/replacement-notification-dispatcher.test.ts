import { describe, expect, it, vi } from "vitest";
import { ReplacementNotificationDispatcher, revertReplacementIfOwner } from "../replacement-notification-dispatcher.js";

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

        expect(sendMessage.mock.calls[0]![1]).toMatch(/потрібне ваше рішення/u);
        expect(sendMessage.mock.calls[0]![1]).not.toMatch(/автоматично підтверджено/u);
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
