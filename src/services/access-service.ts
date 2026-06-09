import { TEAM_CHATS } from "../config.js";
import { userRepository } from "../repositories/user-repository.js";
import { Role, CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";
import { securityAudit } from "../core/audit-logger.js";

export class AccessService {
    public chatId: number;
    public staticJoinLink = "https://t.me/+FuFRMGsvMktkNGFi";
    private api: any; // Raw grammY API instance
    private revokeInFlight = new Map<string, Promise<void>>();

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

    private getRevocationChatIds(): number[] {
        return Array.from(new Set([
            TEAM_CHATS.CHANNEL,
            TEAM_CHATS.HUB,
            TEAM_CHATS.SUPPORT,
        ].filter((chatId): chatId is number => Boolean(chatId) && !Number.isNaN(chatId))));
    }

    private async clearProtectedChatBan(telegramId: bigint) {
        const api = this.getSafeApi();
        for (const chatId of this.getRevocationChatIds()) {
            await api.unbanChatMember(chatId, Number(telegramId), { only_if_banned: true }).catch((e: any) => {
                const description = String(e?.description || "").toLowerCase();
                if (!description.includes("user not found") && !description.includes("user is not a member")) {
                    logger.warn({ err: e, chatId, telegramId }, "Failed to clear protected chat ban");
                }
            });
        }
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
                CandidateStatus.MENTOR_MANUAL,
                CandidateStatus.DISCOVERY_SCHEDULED,
                CandidateStatus.DISCOVERY_COMPLETED,
                CandidateStatus.TRAINING_SCHEDULED,
                CandidateStatus.TRAINING_COMPLETED,
                CandidateStatus.NDA,
                CandidateStatus.KNOWLEDGE_TEST,
                CandidateStatus.STAGING_SETUP,
                CandidateStatus.STAGING_ACTIVE,
                CandidateStatus.READY_FOR_HIRE,
                CandidateStatus.AWAITING_FIRST_SHIFT,
                CandidateStatus.HIRED,
            ];
            return allowedStatuses.includes(status);
        }

        return false;
    }

    /**
     * Proactively syncs user access (bans if unauthorized).
     */
    async syncUserAccess(telegramId: bigint, reason: string = "Routine Sync") {
        try {
            const authorized = await this.isAuthorized(telegramId);
            if (authorized) {
                await this.clearProtectedChatBan(telegramId);
                return;
            }
            await this.revokeAccess(telegramId, reason);
        } catch (e) {
            logger.error({ err: e, telegramId }, "Failed to sync user access");
        }
    }

    /**
     * Removes user from the channel and keeps the ban in place.
     */
    async revokeAccess(telegramId: bigint, reason: string = "Unauthorized") {
        const key = telegramId.toString();
        const inFlight = this.revokeInFlight.get(key);
        if (inFlight) {
            await inFlight;
            return;
        }

        const revokePromise = (async () => {
            const chatIds = this.getRevocationChatIds();
            try {
                securityAudit({
                    event: "security.channel_access.revoked",
                    result: "started",
                    actorType: "system",
                    telegramId,
                    entityType: "channel_access",
                    context: { reason, chatIds }
                });
                const api = this.getSafeApi();

                const failures: Array<{ chatId: number; error: string }> = [];
                for (const chatId of chatIds) {
                    try {
                        await api.banChatMember(chatId, Number(telegramId));
                    } catch (e: any) {
                        const description = String(e?.description || "").toLowerCase();
                        if (description.includes("user not found") || description.includes("participant_id_invalid")) {
                            continue;
                        }
                        failures.push({ chatId, error: e?.description || e?.message || "Unknown Telegram API error" });
                        logger.error({ err: e, chatId, telegramId }, "Failed to revoke protected chat access");
                    }
                }

                securityAudit({
                    event: "security.channel_access.revoked",
                    result: failures.length > 0 ? "failed" : "success",
                    actorType: "system",
                    telegramId,
                    entityType: "channel_access",
                    context: { reason, chatIds, failedChats: failures.length }
                });
            } catch (e: any) {
                if (e.description?.includes("user is not a member")) return;
                securityAudit({
                    event: "security.channel_access.revoked",
                    result: "failed",
                    actorType: "system",
                    telegramId,
                    entityType: "channel_access",
                    error: e.message,
                    context: { reason, chatId: this.chatId }
                });
                logger.error({ err: e, telegramId }, "Failed to revoke channel access");
            }
        })();

        this.revokeInFlight.set(key, revokePromise);

        try {
            await revokePromise;
        } finally {
            if (this.revokeInFlight.get(key) === revokePromise) {
                this.revokeInFlight.delete(key);
            }
        }
    }

    /**
     * Generates a one-time invite link for authorized users.
     */
    async createInviteLink(telegramId: bigint): Promise<string | null> {
        try {
            if (!(await this.isAuthorized(telegramId))) return null;
            const api = this.getSafeApi();
            await this.clearProtectedChatBan(telegramId);
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
