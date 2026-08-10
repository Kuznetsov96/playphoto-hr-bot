import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findActive: vi.fn(),
    findAllLocations: vi.fn(),
    broadcastCreate: vi.fn(),
    broadcastUpdate: vi.fn(),
    deliveryCreateMany: vi.fn(),
    deliveryFindUnique: vi.fn(),
    deliveryClaimPending: vi.fn(),
    deliveryMarkSent: vi.fn(),
    deliveryMarkSkipped: vi.fn(),
    deliveryMarkFailed: vi.fn(),
    deliveryGetStats: vi.fn(),
    trackedMessageCreate: vi.fn(),
    pendingReplyCreate: vi.fn(),
    missingSchedulePreferences: vi.fn(),
    redisGet: vi.fn(),
    logBusinessEvent: vi.fn(),
}));

vi.mock("../../config.js", () => ({
    TEAM_CHATS: { HUB: -1 },
    AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: true,
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: mocks.logBusinessEvent }));
vi.mock("../../core/redis.js", () => ({ redis: { get: mocks.redisGet } }));
vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: { missingSchedulePreferences: mocks.missingSchedulePreferences },
}));
vi.mock("../../repositories/staff-repository.js", () => ({
    staffRepository: { findActive: mocks.findActive },
}));
vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: { findAll: mocks.findAllLocations },
}));
vi.mock("../../repositories/broadcast-repository.js", () => ({
    broadcastRepository: { create: mocks.broadcastCreate, update: mocks.broadcastUpdate },
}));
vi.mock("../../repositories/broadcast-delivery-repository.js", () => ({
    broadcastDeliveryRepository: {
        createMany: mocks.deliveryCreateMany,
        findUnique: mocks.deliveryFindUnique,
        claimPending: mocks.deliveryClaimPending,
        markSent: mocks.deliveryMarkSent,
        markSkipped: mocks.deliveryMarkSkipped,
        markFailed: mocks.deliveryMarkFailed,
        getStats: mocks.deliveryGetStats,
    },
}));
vi.mock("../../repositories/tracked-message-repository.js", () => ({
    trackedMessageRepository: { create: mocks.trackedMessageCreate },
}));
vi.mock("../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { create: mocks.pendingReplyCreate },
}));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: {} }));

const { broadcastService } = await import("../broadcast.js");

const FILLED_USER_ID = 111;
const MISSING_USER_ID = 222;

function staffMember(telegramId: number) {
    return { user: { telegramId: BigInt(telegramId) }, locationId: null, location: null };
}

describe("preferences broadcast — canonical missing-list skip check", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findActive.mockResolvedValue([staffMember(FILLED_USER_ID), staffMember(MISSING_USER_ID)]);
        mocks.broadcastCreate.mockResolvedValue({ id: 1 });
        mocks.deliveryCreateMany.mockResolvedValue({ count: 2 });
        mocks.deliveryFindUnique.mockImplementation(async (_broadcastId: number, chatId: bigint) => ({
            id: Number(chatId),
            status: "PENDING",
        }));
        mocks.deliveryClaimPending.mockResolvedValue({ count: 1 });
        mocks.deliveryMarkSent.mockResolvedValue(undefined);
        mocks.deliveryMarkSkipped.mockResolvedValue(undefined);
        mocks.deliveryGetStats.mockResolvedValue({ SENT: 1, SKIPPED: 1 });
        mocks.trackedMessageCreate.mockResolvedValue({ id: 5 });
        mocks.pendingReplyCreate.mockResolvedValue({});
        mocks.broadcastUpdate.mockResolvedValue(undefined);
    });

    const botApi = { sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }) };

    it("(a) skips a user absent from /missing and sends to a user present in it", async () => {
        mocks.missingSchedulePreferences.mockResolvedValue({
            month: "2026-09",
            employees: [{ publicId: "11111111-1111-4111-8111-111111111111", telegramId: String(MISSING_USER_ID) }],
        });

        await broadcastService.processBroadcast(
            {
                broadcastId: 1,
                messageText: "Заповни побажання",
                target: { type: "pm_all" },
                pingOptions: { buttonType: "preferences" },
            },
            botApi,
        );

        // FILLED_USER_ID is not in the /missing set → skipped, never sent to.
        expect(mocks.deliveryMarkSkipped).toHaveBeenCalledWith(FILLED_USER_ID, "PREFERENCES_ALREADY_FILLED");
        // MISSING_USER_ID is in the /missing set → sent to.
        expect(mocks.deliveryMarkSent).toHaveBeenCalledWith(MISSING_USER_ID, 99);
        expect(mocks.redisGet).not.toHaveBeenCalled();
    });

    it("(b) calls /missing exactly once per run, not once per recipient", async () => {
        mocks.missingSchedulePreferences.mockResolvedValue({
            month: "2026-09",
            employees: [{ publicId: "11111111-1111-4111-8111-111111111111", telegramId: String(MISSING_USER_ID) }],
        });

        await broadcastService.processBroadcast(
            {
                broadcastId: 1,
                messageText: "Заповни побажання",
                target: { type: "pm_all" },
                pingOptions: { buttonType: "preferences" },
            },
            botApi,
        );

        expect(mocks.missingSchedulePreferences).toHaveBeenCalledTimes(1);
    });

    it("(c) falls back to the Redis check when /missing fails, instead of sending to everyone", async () => {
        mocks.missingSchedulePreferences.mockRejectedValue(new Error("AWS business API request failed with HTTP 503"));
        // Redis fallback: FILLED_USER_ID has already filled in (key present), MISSING_USER_ID has not.
        mocks.redisGet.mockImplementation(async (key: string) =>
            key.startsWith(`pref_filled:${FILLED_USER_ID}:`) ? "1" : null,
        );

        await broadcastService.processBroadcast(
            {
                broadcastId: 1,
                messageText: "Заповни побажання",
                target: { type: "pm_all" },
                pingOptions: { buttonType: "preferences" },
            },
            botApi,
        );

        expect(mocks.deliveryMarkSkipped).toHaveBeenCalledWith(FILLED_USER_ID, "PREFERENCES_ALREADY_FILLED");
        expect(mocks.deliveryMarkSent).toHaveBeenCalledWith(MISSING_USER_ID, 99);
        expect(mocks.redisGet).toHaveBeenCalled();
        expect(mocks.logBusinessEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                event: "bot.preferences_missing_check.fallback",
                reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
            }),
        );
        // Fallback log must not leak identifying data.
        const fallbackCall = mocks.logBusinessEvent.mock.calls.find(
            (call) => call[0]?.event === "bot.preferences_missing_check.fallback",
        );
        expect(JSON.stringify(fallbackCall?.[0])).not.toContain(String(FILLED_USER_ID));
        expect(JSON.stringify(fallbackCall?.[0])).not.toContain(String(MISSING_USER_ID));
    });
});
