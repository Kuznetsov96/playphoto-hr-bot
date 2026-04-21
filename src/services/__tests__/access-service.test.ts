import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessService } from "../access-service.js";
import { CandidateStatus, Role } from "@prisma/client";

const mocks = vi.hoisted(() => ({
    findWithProfilesByTelegramId: vi.fn(),
    securityAudit: vi.fn(),
    loggerError: vi.fn(),
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
    },
}));

describe("AccessService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("deduplicates concurrent revoke attempts for the same user", async () => {
        const service = new AccessService();
        const banChatMember = vi.fn().mockResolvedValue(undefined);
        const unbanChatMember = vi.fn().mockResolvedValue(undefined);

        service.setApi({ banChatMember, unbanChatMember });
        mocks.findWithProfilesByTelegramId.mockResolvedValue(null);

        await Promise.all([
            service.syncUserAccess(123n, "Routine Sync"),
            service.syncUserAccess(123n, "Routine Sync"),
        ]);

        expect(banChatMember).toHaveBeenCalledTimes(1);
        expect(unbanChatMember).toHaveBeenCalledTimes(1);
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
});
