import type { Api } from "grammy";

import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { knownChatRepository } from "../repositories/known-chat-repository.js";
import { TEAM_CHATS } from "../config.js";

export interface ReconcileResult {
    confirmed: number;
    lost: number;
    discovered: number;
}

interface SweepTarget {
    id: bigint;
    title: string | null;
    /** true when this chat is not yet in the registry — a hit here is "discovered", not "confirmed". */
    isSeed: boolean;
}

/**
 * Chat ids the bot already knows about outside the registry: the three static team chats
 * and every location's Telegram chat. Folded in on every sweep (not only when the registry
 * is empty) so a location chat added after the first run is still picked up.
 *
 * `TEAM_CHATS.*` are `parseInt(env.X)` and are `NaN` when the env var is unset — filtered
 * here because `BigInt(NaN)` throws. `Location.telegramChatId` is nullable for the same reason.
 */
async function seedChatIds(): Promise<bigint[]> {
    const teamChatIds = [TEAM_CHATS.CHANNEL, TEAM_CHATS.HUB, TEAM_CHATS.SUPPORT]
        .filter((chatId): chatId is number => Boolean(chatId) && !Number.isNaN(chatId))
        .map((chatId) => BigInt(chatId));

    const locations = await prisma.location.findMany({
        where: { telegramChatId: { not: null } },
        select: { telegramChatId: true },
    });
    const locationChatIds = locations
        .map((location) => location.telegramChatId)
        .filter((chatId): chatId is bigint => chatId !== null);

    return [...teamChatIds, ...locationChatIds];
}

/**
 * Confirms every chat the registry claims is active, marks the ones the bot can no longer
 * use as lost, and folds in chat ids the bot already knows about outside the registry
 * (team chats, location chats) so they enter it without anyone writing them down by hand.
 *
 * Each chat is checked independently: one unreachable chat must not abort the sweep for
 * the rest.
 */
export async function reconcileKnownChats(api: Api): Promise<ReconcileResult> {
    const [active, seedIds] = await Promise.all([knownChatRepository.listActive(), seedChatIds()]);

    const targets = new Map<bigint, SweepTarget>();
    for (const chat of active) {
        targets.set(chat.id, { id: chat.id, title: chat.title, isSeed: false });
    }
    for (const id of seedIds) {
        if (!targets.has(id)) {
            targets.set(id, { id, title: null, isSeed: true });
        }
    }

    const result: ReconcileResult = { confirmed: 0, lost: 0, discovered: 0 };
    if (targets.size === 0) {
        logBusinessEvent({
            event: "known_chat.reconcile.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "known-chat-reconciler",
            operation: "reconcileKnownChats",
            safeContext: { ...result },
        });
        return result;
    }

    const me = await api.getMe();

    for (const target of targets.values()) {
        try {
            const member = await api.getChatMember(target.id.toString(), me.id);
            // Any status other than administrator means the bot cannot check presence or
            // ban in this chat — demotion is a loss, not a degraded-but-usable state.
            if (member.status !== "administrator") {
                // Same guard as the catch below: a seed chat was never in the registry,
                // so `recordLost`'s Prisma `update` would throw P2025 on the missing row.
                // Reachable-but-demoted is still not persisted for a seed — there is no
                // row to mark lost, only a count to report.
                if (!target.isSeed) {
                    await knownChatRepository.recordLost(target.id);
                }
                result.lost += 1;
                continue;
            }

            // getChatMember already proved the bot is administrator here — that is the
            // presence check, full stop. getChat is only for a nicer title/type; a
            // transient failure on it (rate limit, network blip) must not flip this
            // chat to lost, or a chat wrongly dropped from the registry is a chat a
            // fired person keeps access to. Fall back to what's already known.
            let title = target.title;
            let type = "unknown";
            try {
                const chat = await api.getChat(target.id.toString());
                title = "title" in chat ? (chat.title ?? null) : target.title;
                type = chat.type;
            } catch (getChatError) {
                logger.warn(
                    { err: getChatError, chatId: target.id.toString() },
                    "known-chat-reconciler: getChat failed after confirming administrator, using fallback title/type",
                );
            }
            await knownChatRepository.recordPresent({
                id: target.id,
                title,
                type,
            });
            if (target.isSeed) {
                result.discovered += 1;
            } else {
                result.confirmed += 1;
            }
        } catch (error) {
            logger.warn({ err: error, chatId: target.id.toString() }, "known-chat-reconciler: chat unreachable, marking lost");
            // A seed chat that was never in the registry has no row to mark lost —
            // `recordLost` does a Prisma `update`, which throws on a missing row.
            // There is nothing to persist for a seed that was never reachable.
            if (!target.isSeed) {
                try {
                    await knownChatRepository.recordLost(target.id);
                } catch (recordError) {
                    logger.error({ err: recordError, chatId: target.id.toString() }, "known-chat-reconciler: failed to record lost chat");
                }
            }
            result.lost += 1;
        }
    }

    logBusinessEvent({
        event: "known_chat.reconcile.completed",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "known-chat-reconciler",
        operation: "reconcileKnownChats",
        safeContext: { ...result },
    });

    return result;
}
