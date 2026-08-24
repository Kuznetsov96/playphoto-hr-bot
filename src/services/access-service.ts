import { TEAM_CHATS } from "../config.js";
import { userRepository } from "../repositories/user-repository.js";
import { knownChatRepository } from "../repositories/known-chat-repository.js";
import { Role, CandidateStatus } from "@prisma/client";
import logger from "../core/logger.js";
import { securityAudit } from "../core/audit-logger.js";

export class AccessService {
    public chatId: number;
    public staticJoinLink = "https://t.me/+FuFRMGsvMktkNGFi";
    private api: any; // Raw grammY API instance
    private revokeInFlight = new Map<
        string,
        Promise<{ attemptedChats: number; failures: Array<{ chatId: number; error: string }> }>
    >();

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
     * The scope of a revocation is every chat the bot is currently in, not a
     * hardcoded list: the team channel arrives through the registry like any
     * location chat, and a fired photographer must lose the chat they actually
     * worked in. Ids are `bigint` in the registry and `number` at the Telegram
     * API boundary, so they are narrowed here once.
     */
    private async getRevocationChats(): Promise<Array<{ id: number; title: string | null }>> {
        const chats = await knownChatRepository.listActive();
        const seen = new Set<number>();
        const result: Array<{ id: number; title: string | null }> = [];
        for (const chat of chats) {
            const id = Number(chat.id);
            if (!id || Number.isNaN(id) || seen.has(id)) continue;
            seen.add(id);
            result.push({ id, title: chat.title });
        }
        return result;
    }

    private async clearProtectedChatBan(telegramId: bigint) {
        const api = this.getSafeApi();
        // Un-banning follows the same scope as banning: otherwise a re-hired
        // person stays banned in their location chat forever and no invite
        // link will let them back in.
        const chats = await this.getRevocationChats();
        for (const { id: chatId } of chats) {
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
     *
     * Returns the chats that were attempted and the subset that refused to
     * ban the user (`failures` is empty when every chat succeeded, including
     * the "already not a member" cases treated as success below). This never
     * throws for a partial failure — `securityAudit` already records
     * `result: "failed"` for that case, and callers that only care whether
     * it ran at all can keep ignoring the return value exactly as before.
     * Callers that must not treat a partial removal as a real revocation
     * (the access-revocation dispatcher) read the returned counts instead.
     */
    async revokeAccess(
        telegramId: bigint,
        reason: string = "Unauthorized"
    ): Promise<{ attemptedChats: number; failures: Array<{ chatId: number; error: string }> }> {
        const key = telegramId.toString();
        const inFlight = this.revokeInFlight.get(key);
        if (inFlight) {
            return inFlight;
        }

        const revokePromise = (async (): Promise<{ attemptedChats: number; failures: Array<{ chatId: number; error: string }> }> => {
            // Fetched before the try so the catch below can always read it, and
            // handled separately: an unreadable registry means the scope is
            // unknown, not empty. Returning a clean result there would record a
            // revocation that never looked at a single chat while the dispatcher
            // marks the row PROCESSED, so it has to come back as a failure to be
            // retried.
            let chats: Array<{ id: number; title: string | null }> = [];
            try {
                chats = await this.getRevocationChats();
            } catch (e: any) {
                securityAudit({
                    event: "security.channel_access.revoked",
                    result: "failed",
                    actorType: "system",
                    telegramId,
                    entityType: "channel_access",
                    error: e?.message,
                    context: { reason, chats: [] }
                });
                logger.error({ err: e, telegramId }, "Failed to read the known chat registry for revocation");
                return {
                    attemptedChats: 0,
                    failures: [{ chatId: 0, error: e?.description || e?.message || "Failed to read the known chat registry" }]
                };
            }

            // Titles travel into the audit alongside the ids so the record
            // answers "from where", not "which numbers were passed".
            const auditChats = chats.map(chat => ({ id: chat.id, title: chat.title }));
            try {
                securityAudit({
                    event: "security.channel_access.revoked",
                    result: "started",
                    actorType: "system",
                    telegramId,
                    entityType: "channel_access",
                    context: { reason, chats: auditChats }
                });
                const api = this.getSafeApi();

                const failures: Array<{ chatId: number; error: string }> = [];
                for (const { id: chatId } of chats) {
                    // Ban only where the person actually is: a ban in a chat they
                    // were never in is a false audit record of access that never
                    // existed.
                    let member: { status: string };
                    try {
                        member = await api.getChatMember(chatId, Number(telegramId));
                    } catch (e: any) {
                        // Чат, который не удалось опросить, — это НЕ «человека там нет». Считать
                        // иначе значит превратить сетевой сбой в «мы проверили» и оставить
                        // человека в чате с записью PROCESSED.
                        failures.push({ chatId, error: e?.description || e?.message || "Presence check failed" });
                        logger.error({ err: e, chatId, telegramId }, "Failed to check protected chat membership");
                        continue;
                    }
                    if (member?.status === "left" || member?.status === "kicked") continue;

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
                    context: { reason, chats: auditChats, failedChats: failures.length }
                });
                return { attemptedChats: chats.length, failures };
            } catch (e: any) {
                if (e.description?.includes("user is not a member")) return { attemptedChats: chats.length, failures: [] };
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
                return {
                    attemptedChats: chats.length,
                    failures: [{ chatId: this.chatId, error: e?.description || e?.message || "Unknown Telegram API error" }]
                };
            }
        })();

        this.revokeInFlight.set(key, revokePromise);

        try {
            return await revokePromise;
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
