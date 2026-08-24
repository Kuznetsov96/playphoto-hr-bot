import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessService } from "../access-service.js";
import { CandidateStatus, Role } from "@prisma/client";

const mocks = vi.hoisted(() => ({
    findWithProfilesByTelegramId: vi.fn(),
    securityAudit: vi.fn(),
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    listActive: vi.fn(),
}));

vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: {
        findWithProfilesByTelegramId: mocks.findWithProfilesByTelegramId,
    },
}));

vi.mock("../../core/audit-logger.js", () => ({
    securityAudit: mocks.securityAudit,
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        error: mocks.loggerError,
        warn: mocks.loggerWarn,
    },
}));

vi.mock("../../repositories/known-chat-repository.js", () => ({
    knownChatRepository: {
        listActive: mocks.listActive,
    },
}));

describe("AccessService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Scope now comes from the registry, so every test needs one. The
        // pre-existing cases below assert deduplication and unban-before-invite,
        // which are independent of *which* chats are in scope — one chat is
        // enough to exercise them.
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Support" }]);
    });

    it("deduplicates concurrent revoke attempts for the same user", async () => {
        const service = new AccessService();
        const banChatMember = vi.fn().mockResolvedValue(undefined);
        const unbanChatMember = vi.fn().mockResolvedValue(undefined);
        const getChatMember = vi.fn().mockResolvedValue({ status: "member" });

        service.setApi({ banChatMember, unbanChatMember, getChatMember });
        mocks.findWithProfilesByTelegramId.mockResolvedValue(null);

        await Promise.all([
            service.syncUserAccess(123n, "Routine Sync"),
            service.syncUserAccess(123n, "Routine Sync"),
        ]);

        expect(banChatMember).toHaveBeenCalled();
        expect(unbanChatMember).not.toHaveBeenCalled();
        expect(mocks.securityAudit).toHaveBeenCalledTimes(2);
        expect(mocks.securityAudit).toHaveBeenNthCalledWith(1, expect.objectContaining({
            event: "security.channel_access.revoked",
            result: "started",
            telegramId: 123n,
        }));
        expect(mocks.securityAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({
            event: "security.channel_access.revoked",
            result: "success",
            telegramId: 123n,
        }));
    });

    it("allows candidates throughout discovery and training access window", async () => {
        const service = new AccessService();

        for (const status of [
            CandidateStatus.ACCEPTED,
            CandidateStatus.DISCOVERY_SCHEDULED,
            CandidateStatus.DISCOVERY_COMPLETED,
            CandidateStatus.TRAINING_SCHEDULED,
            CandidateStatus.TRAINING_COMPLETED,
        ]) {
            mocks.findWithProfilesByTelegramId.mockResolvedValueOnce({
                role: Role.CANDIDATE,
                candidate: { status },
            });

            await expect(service.isAuthorized(123n)).resolves.toBe(true);
        }
    });

    it("allows candidates awaiting first shift or already hired before staff promotion catches up", async () => {
        const service = new AccessService();

        for (const status of [
            CandidateStatus.AWAITING_FIRST_SHIFT,
            CandidateStatus.HIRED,
        ]) {
            mocks.findWithProfilesByTelegramId.mockResolvedValueOnce({
                role: Role.CANDIDATE,
                candidate: { status },
            });

            await expect(service.isAuthorized(123n)).resolves.toBe(true);
        }
    });

    it("authorizes candidates in the manual mentor track", async () => {
        const service = new AccessService();
        mocks.findWithProfilesByTelegramId.mockResolvedValueOnce({
            role: Role.CANDIDATE,
            candidate: { status: CandidateStatus.MENTOR_MANUAL },
        });

        await expect(service.isAuthorized(123n)).resolves.toBe(true);
    });

    it("clears existing protected chat bans before creating a valid one-time invite", async () => {
        const service = new AccessService();
        const unbanChatMember = vi.fn().mockResolvedValue(undefined);
        const createChatInviteLink = vi.fn().mockResolvedValue({ invite_link: "https://t.me/+fresh" });

        service.setApi({ unbanChatMember, createChatInviteLink });
        mocks.findWithProfilesByTelegramId.mockResolvedValue({
            role: Role.STAFF,
            staffProfile: { isActive: true },
        });

        await expect(service.createInviteLink(123n)).resolves.toBe("https://t.me/+fresh");
        expect(unbanChatMember).toHaveBeenCalled();
        expect(unbanChatMember).toHaveBeenCalledWith(expect.any(Number), 123, { only_if_banned: true });
        expect(createChatInviteLink).toHaveBeenCalledTimes(1);
    });

    it("clears protected chat bans during routine sync for authorized users", async () => {
        const service = new AccessService();
        const unbanChatMember = vi.fn().mockResolvedValue(undefined);

        service.setApi({ unbanChatMember });
        mocks.findWithProfilesByTelegramId.mockResolvedValue({
            role: Role.STAFF,
            staffProfile: { isActive: true },
        });

        await service.syncUserAccess(123n, "Routine Sync");

        expect(unbanChatMember).toHaveBeenCalled();
        expect(unbanChatMember).toHaveBeenCalledWith(expect.any(Number), 123, { only_if_banned: true });
    });
});

describe("revokeAccess — presence-driven scope", () => {
    let service: AccessService;
    let banChatMember: ReturnType<typeof vi.fn>;
    let getChatMember: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new AccessService();
        banChatMember = vi.fn().mockResolvedValue(undefined);
        getChatMember = vi.fn().mockResolvedValue({ status: "member" });
        service.setApi({ banChatMember, getChatMember, unbanChatMember: vi.fn().mockResolvedValue(undefined) });
    });

    /**
     * The point of the change: ban only where the person actually is. A ban in a chat they were
     * never in is a false audit record of access that never existed.
     */
    it("bans only the chats the person is in", async () => {
        mocks.listActive.mockResolvedValue([
            { id: -100n, title: "Support" },
            { id: -101n, title: "Fantasy Town" },
            { id: -102n, title: "Dragon Park" },
        ]);
        getChatMember
            .mockResolvedValueOnce({ status: "member" })
            .mockResolvedValueOnce({ status: "member" })
            .mockResolvedValueOnce({ status: "left" });

        await service.revokeAccess(12345n, "Звільнення");

        expect(banChatMember).toHaveBeenCalledTimes(2);
        expect(banChatMember).toHaveBeenCalledWith(-100, 12345);
        expect(banChatMember).toHaveBeenCalledWith(-101, 12345);
    });

    it("bans nothing when the person is in no chat", async () => {
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Support" }]);
        getChatMember.mockResolvedValue({ status: "left" });

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(banChatMember).not.toHaveBeenCalled();
        expect(result.failures).toHaveLength(0);
    });

    /**
     * A chat that could not be queried is NOT an absence. Treating it as one turns a network
     * blip into "we checked, they were not there" while the person stays in the chat.
     */
    it("treats an unqueryable chat as a failure, not an absence", async () => {
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Support" }]);
        getChatMember.mockRejectedValue(new Error("500: Internal Server Error"));

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(result.failures).toHaveLength(1);
        expect(banChatMember).not.toHaveBeenCalled();
    });

    /** Already kicked is the goal already achieved, not a failure. */
    it("counts an already-kicked person as success", async () => {
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Support" }]);
        getChatMember.mockResolvedValue({ status: "kicked" });

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(result.failures).toHaveLength(0);
        expect(banChatMember).not.toHaveBeenCalled();
    });

    it("still fails the row when the ban itself is refused", async () => {
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Support" }]);
        getChatMember.mockResolvedValue({ status: "member" });
        banChatMember.mockRejectedValue({ description: "CHAT_ADMIN_REQUIRED" });

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(result.failures).toHaveLength(1);
    });

    /** A person who vanished between the presence check and the ban is still a success. */
    it("counts a user who left between the check and the ban as success", async () => {
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Support" }]);
        getChatMember.mockResolvedValue({ status: "member" });
        banChatMember.mockRejectedValue({ description: "Bad Request: user not found" });

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(result.failures).toHaveLength(0);
    });

    /** The audit must answer "from where", not "which numbers were passed". */
    it("records chat titles in the audit", async () => {
        mocks.listActive.mockResolvedValue([{ id: -100n, title: "Fantasy Town" }]);
        getChatMember.mockResolvedValue({ status: "member" });

        await service.revokeAccess(12345n, "Звільнення");

        const audit = mocks.securityAudit.mock.calls.at(-1)?.[0];
        expect(JSON.stringify(audit.context)).toContain("Fantasy Town");
    });

    /**
     * If the registry itself cannot be read, the scope is unknown — not empty. Returning a clean
     * result would record a revocation that never examined a single chat and let the dispatcher
     * mark the row PROCESSED, so the failure has to be reported for a retry.
     */
    it("reports a failure when the registry cannot be read", async () => {
        mocks.listActive.mockRejectedValue(new Error("db is down"));

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(result.attemptedChats).toBe(0);
        expect(result.failures).toHaveLength(1);
        expect(banChatMember).not.toHaveBeenCalled();
    });

    /**
     * An empty registry is a system-state problem, not an answer. The bot is always in at least
     * the team channel, so zero known chats means the registry has not been populated yet — the
     * same "cannot determine" that a failed presence check represents, one level up. Recording it
     * as a clean revocation would let the dispatcher mark the row PROCESSED with nobody banned and
     * nothing retrying.
     */
    it("reports a failure when the registry is empty", async () => {
        mocks.listActive.mockResolvedValue([]);

        const result = await service.revokeAccess(12345n, "Звільнення");

        expect(result.attemptedChats).toBe(0);
        expect(result.failures).toHaveLength(1);
        expect(banChatMember).not.toHaveBeenCalled();
        expect(getChatMember).not.toHaveBeenCalled();
    });

    /** Un-banning has to follow the same scope, or a re-hired person stays banned in their location chat. */
    it("clears bans across every registry chat, not just the team channel", async () => {
        const unbanChatMember = vi.fn().mockResolvedValue(undefined);
        service.setApi({ banChatMember, getChatMember, unbanChatMember });
        mocks.listActive.mockResolvedValue([
            { id: -100n, title: "Support" },
            { id: -101n, title: "Fantasy Town" },
        ]);
        mocks.findWithProfilesByTelegramId.mockResolvedValue({
            role: Role.STAFF,
            staffProfile: { isActive: true },
        });

        await service.syncUserAccess(123n, "Routine Sync");

        expect(unbanChatMember).toHaveBeenCalledTimes(2);
        expect(unbanChatMember).toHaveBeenCalledWith(-100, 123, { only_if_banned: true });
        expect(unbanChatMember).toHaveBeenCalledWith(-101, 123, { only_if_banned: true });
    });
});
