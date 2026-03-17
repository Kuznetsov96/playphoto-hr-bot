import { TEAM_CHATS } from "../config.js";
import { userRepository } from "../repositories/user-repository.js";
import { Role, CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";

export class AccessService {
    public chatId: number;
    public staticJoinLink = "https://t.me/+FuFRMGsvMktkNGFi";
    private api: any; // Raw grammY API instance

    constructor() {
        this.chatId = TEAM_CHATS.CHANNEL;
    }

    /**
     * Injects the bot API instance to avoid circular dependencies
     */
    setApi(api: any) {
        this.api = api;
    }

    private getSafeApi() {
        if (!this.api) {
            throw new Error("AccessService: API not initialized. Call setApi(bot.api) first.");
        }
        return this.api;
    }

    /**
     * Checks if a user is authorized to be in the team channel.
     * Unified logic: Active Staff, Admins, or Candidates in Mentorship/Training.
     */
    async isAuthorized(telegramId: bigint): Promise<boolean> {
        if (!telegramId) return false;
        const user = await userRepository.findWithProfilesByTelegramId(telegramId);
        if (!user) return false;

        // 1. Admins, HRs, Mentors always have access
        const privilegedRoles: Role[] = [Role.ADMIN, Role.HR, Role.MENTOR];
        if (privilegedRoles.includes(user.role)) return true;

        // 2. Staff members (must be ACTIVE)
        if (user.role === Role.STAFF) {
            return user.staffProfile?.isActive === true;
        }

        // 3. Candidates (ONLY if they passed HR stage and are now in Training/Staging)
        if (user.role === Role.CANDIDATE && user.candidate) {
            const status = user.candidate.status;
            const allowedStatuses: CandidateStatus[] = [
                CandidateStatus.ACCEPTED,
                CandidateStatus.TRAINING_SCHEDULED,
                CandidateStatus.NDA,
                CandidateStatus.KNOWLEDGE_TEST,
                CandidateStatus.STAGING_SETUP,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.READY_FOR_HIRE
            ];
            return allowedStatuses.includes(status);
        }

        return false;
    }

    /**
     * Proactively syncs user access (kicks if unauthorized).
     */
    async syncUserAccess(telegramId: bigint, reason: string = "Routine Sync") {
        try {
            const authorized = await this.isAuthorized(telegramId);
            if (!authorized) {
                await this.revokeAccess(telegramId, reason);
            }
        } catch (e) {
            logger.error({ err: e, telegramId }, "Failed to sync user access");
        }
    }

    /**
     * Removes user from the channel.
     */
    async revokeAccess(telegramId: bigint, reason: string = "Unauthorized") {
        try {
            logger.warn({ telegramId, reason }, `[AUDIT] 🚨 REVOKING channel access for User ${telegramId.toString()} | Reason: ${reason}`);
            const api = this.getSafeApi();
            await api.banChatMember(this.chatId, Number(telegramId));
            await api.unbanChatMember(this.chatId, Number(telegramId));
            logger.info({ telegramId }, `[AUDIT] ✅ Successfully revoked access for User ${telegramId.toString()}`);
        } catch (e: any) {
            if (e.description?.includes("user is not a member")) return;
            logger.error({ err: e, telegramId }, `[AUDIT] ❌ Failed to revoke access for User ${telegramId.toString()}`);
        }
    }

    /**
     * Generates a one-time invite link for authorized users.
     */
    async createInviteLink(telegramId: bigint): Promise<string | null> {
        try {
            if (!(await this.isAuthorized(telegramId))) return null;
            const api = this.getSafeApi();
            const link = await api.createChatInviteLink(this.chatId, {
                member_limit: 1,
                name: `Invite for ${telegramId.toString()}`
            });
            return link.invite_link;
        } catch (e) {
            logger.error({ err: e, telegramId }, "Failed to create invite link");
            return null;
        }
    }
}

export const accessService = new AccessService();
