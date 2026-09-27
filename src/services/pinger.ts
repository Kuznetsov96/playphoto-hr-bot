import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { pendingReplyRepository } from "../repositories/pending-reply-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { CandidateStatus } from "@prisma/client";
import { BUSINESS_DATA_SOURCE, PING_CONFIG, ADMIN_IDS, HR_IDS } from "../config.js";
import { scheduleSyncService } from "./schedule-sync.js";
import logger from "../core/logger.js";
import { logBusinessEvent, logSecurityEvent } from "../core/log-events.js";
import { handleBlockedCandidate } from "../utils/bot-blocked.js";
import { isQuietHour, nextAllowedPingTime } from "../utils/quiet-hours.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
import { formatLocalDate } from "../utils/format-deadline.js";
import { awsBusinessClient, type SchedulePreferenceSchedule } from "./aws-business-client.js";
import { monthNameFromCanonical } from "./preference-month.js";

// Only HR-stage statuses — pinger broadcast targets early funnel
const ACTIVE_CANDIDATE_STATUSES: CandidateStatus[] = [
    CandidateStatus.SCREENING,
    CandidateStatus.WAITLIST,
    CandidateStatus.WAITLIST_HR,
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
];

async function handleBlockedUser(bot: Bot<MyContext>, telegramId: number) {
    try {
        const userWithProfile = await userRepository.findWithProfilesByTelegramId(BigInt(telegramId));
        if (!userWithProfile) return;

        const staff = userWithProfile.staffProfile;
        const candidate = userWithProfile.candidate;

        // --- Staff ---
        if (staff?.isActive) {
            const staffName = staff.surnameNameDot || staff.fullName;
            if (BUSINESS_DATA_SOURCE === "aws") {
                logger.warn({ telegramId, staffId: staff.id }, "Staff blocked bot; AWS owner notification started");
                await scheduleSyncService.markStaffBotBlocked(telegramId);
                logSecurityEvent({
                    event: "security.staff.bot_blocked",
                    telegramId,
                    userId: userWithProfile.id,
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "pinger",
                    operation: "handleBlockedUser",
                    safeContext: {
                        staffId: staff.id,
                        staffName,
                        action: "owner_notification_required",
                        businessStatusChanged: false,
                    },
                });
                const adminId = ADMIN_IDS[0];
                if (adminId) {
                    const text = `🚫 <b>Staff Bot Blocked</b>\n\n` +
                        `👤 <b>${escapeHtml(staffName)}</b> blocked the bot.\n\n` +
                        `Статус сотрудника в AWS <b>не изменён автоматически</b>. Проверьте ситуацию и, если сотрудник действительно уволен, деактивируйте его в основной базе.`;
                    await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" }).catch(() => { });
                }
                return;
            }

            logger.warn({ telegramId, staffId: staff.id }, "Staff blocked bot; auto-deactivation started");

            await staffRepository.update(staff.id, {
                isActive: false,
                deactivatedAt: new Date(),
                deactivatedBy: "system:pinger",
                deactivatedSource: "BOT_BLOCKED",
                deactivatedReason: "Telegram 403 bot blocked"
            } as any);
            await scheduleSyncService.markStaffBotBlocked(telegramId);
            logSecurityEvent({
                event: "security.staff.bot_blocked",
                telegramId,
                userId: userWithProfile.id,
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "pinger",
                operation: "handleBlockedUser",
                safeContext: {
                    staffId: staff.id,
                    staffName,
                    action: "auto_deactivated",
                },
            });

            const adminId = ADMIN_IDS[0];
            if (adminId) {
                const text = `🚫 <b>Staff Bot Blocked</b>\n\n` +
                    `👤 <b>${escapeHtml(staffName)}</b> blocked the bot.\n\n` +
                    `Automatic actions completed:\n` +
                    `• Status → <b>Offboarded</b>\n` +
                    `• Channel access — removed\n` +
                    `• Staff sheet — updated`;
                await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" }).catch(() => { });
            }
            return;
        }

        // --- Candidate ---
        if (candidate && ACTIVE_CANDIDATE_STATUSES.includes(candidate.status as CandidateStatus)) {
            const name = candidate.fullName || "Candidate";
            logger.warn({ telegramId, candidateId: candidate.id, stage: candidate.status }, "Candidate blocked bot; blocker archival started");

            await handleBlockedCandidate(bot.api, candidate.id, name);
            logSecurityEvent({
                event: "security.candidate.bot_blocked",
                telegramId,
                userId: userWithProfile.id,
                candidateId: candidate.id,
                actorType: "system",
                actorRole: "system",
                stage: candidate.status,
                result: "success",
                module: "pinger",
                operation: "handleBlockedUser",
                safeContext: {
                    candidateName: name,
                    action: "archived_as_blocker",
                },
            });
            return;
        }

        logger.warn({ telegramId }, "Bot blocked event ignored for inactive or unsupported user");
    } catch (e) {
        logger.error({ err: e, telegramId }, "Blocked user handler failed");
    }
}

function isActiveMembership(member: any): boolean {
    if (!member || !member.status) return false;
    if (member.status === "creator" || member.status === "administrator" || member.status === "member") return true;
    if (member.status === "restricted") return member.is_member !== false;
    return false;
}

async function pruneNonMembersFromPending(msg: any, bot: Bot<MyContext>) {
    const chatId = Number(msg.chatId);
    if (chatId > 0) return msg.pendingReplies;

    const stalePendingIds: number[] = [];
    const stillPending: typeof msg.pendingReplies = [];

    for (const reply of msg.pendingReplies) {
        try {
            const member = await bot.api.getChatMember(chatId, Number(reply.userId));
            if (isActiveMembership(member)) {
                stillPending.push(reply);
            } else {
                stalePendingIds.push(reply.id);
            }
        } catch (e: any) {
            const description = String(e?.description || "").toLowerCase();
            if (
                e?.error_code === 400 ||
                description.includes("user not found") ||
                description.includes("participant_id_invalid") ||
                description.includes("user not participant")
            ) {
                stalePendingIds.push(reply.id);
                continue;
            }
            // Keep the pending reply on transient API failures.
            stillPending.push(reply);
        }
    }

    if (stalePendingIds.length > 0) {
        await pendingReplyRepository.deleteMany({ id: { in: stalePendingIds } });
    }

    return stillPending;
}

export function startPingerLoop(bot: Bot<MyContext>) {
    logBusinessEvent({
        event: "broadcast.pinger_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "pinger",
        operation: "startPingerLoop",
        safeContext: {
            intervalMs: PING_CONFIG.CHECK_INTERVAL_MS,
        },
    });
    setInterval(() => runPinger(bot), PING_CONFIG.CHECK_INTERVAL_MS);
}

/**
 * Экспортируется только для тестов: цикл напоминаний иначе достижим лишь через
 * `setInterval` в `startPingerLoop`, а потолок — как раз то, что нужно проверять
 * прогоном, а не таймером. Продакшен-код вызывает `startPingerLoop`.
 */
export const runPingerForTest = (bot: Bot<MyContext>) => runPinger(bot);

/** Как часто после срока проверять, не продлил ли его владелец. */
const DEADLINE_RECHECK_MS = 60 * 60 * 1000;

/** Первое число месяца после `YYYY-MM` (UTC, ms): позже сбор на этот месяц не нужен. */
function monthAfter(month: string): number {
    const [year, monthNumber] = month.split("-").map(Number) as [number, number];
    return Date.UTC(year, monthNumber, 1);
}

/**
 * Срок и «сбор открыт» для месяца — из вебаппа, один запрос на прогон.
 * `null` — вебапп недоступен: напоминание этого тика не уходит, строка
 * остаётся в очереди и повторится на следующем.
 */
async function preferencesScheduleFor(
    month: string,
    cache: Map<string, SchedulePreferenceSchedule | null>,
): Promise<SchedulePreferenceSchedule | null> {
    if (cache.has(month)) return cache.get(month)!;
    let schedule: SchedulePreferenceSchedule | null = null;
    try {
        schedule = await awsBusinessClient.schedulePreferenceSchedule(month);
    } catch (error) {
        logger.warn({ err: error, month }, "Preference collection schedule unavailable; reminders wait for the next tick");
    }
    cache.set(month, schedule);
    return schedule;
}

async function runPinger(bot: Bot<MyContext>) {
    try {
        const now = new Date();
        const messagesToPing = await trackedMessageRepository.findToPing(now);
        const schedules = new Map<string, SchedulePreferenceSchedule | null>();

        for (const msg of messagesToPing) {
            const activePendingReplies = await pruneNonMembersFromPending(msg, bot);

            // 0. Тихие часы: ночью не отправляем, а переносим на утро.
            //
            // Интервал в 4 часа ровно укладывался в сутки, поэтому сдвига не
            // было — человек получал пинг в 02:00 каждую ночь, пока не ответит.
            // Переносится именно `nextPingAt`, а не пропускается тик: пропуск
            // вернул бы нас сюда через минуту и снова, всю ночь, каждую минуту.
            if (isQuietHour(now)) {
                await trackedMessageRepository.update(msg.id, {
                    nextPingAt: nextAllowedPingTime(now)
                });
                continue;
            }

            // 1. If no pending replies, stop pinging
            if (activePendingReplies.length === 0) {
                await trackedMessageRepository.stopTracking(msg.id);
                logBusinessEvent({
                    event: "broadcast.ping_tracking.completed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "pinger",
                    operation: "runPinger",
                    safeContext: {
                        trackedMessageId: msg.id,
                        chatId: msg.chatId,
                        messageId: msg.messageId,
                    },
                });

                // Try to delete last ping if exists
                if (msg.lastPingMsgId) {
                    try {
                        await bot.api.deleteMessage(Number(msg.chatId), msg.lastPingMsgId);
                    } catch (e) { /* ignore */ }
                }
                continue;
            }

            // 2. Format ping message
            let text = "";
            const isPrivate = Number(msg.chatId) > 0;
            // По полю, а не по тексту рассылки. Раньше здесь было
            // `messageText.includes("Побажання")`, и когда 21.08 приглашение
            // стало начинаться с «Графік на …», сбор пожеланий перестал
            // узнаваться: напоминание уходило как обычная рассылка, с кнопкой
            // «Ознайомлена», и нажатие на неё глушило пинги без подачи.
            const isPreferences = msg.buttonType === "preferences";

            if (isPrivate && isPreferences && msg.targetMonth) {
                // Срок спрашивается перед КАЖДЫМ напоминанием: владелец мог его
                // перенести или закрыть сбор. Раньше напоминания шли до
                // зашитого 26-го, даже если сбор закрыли 25-го.
                // Конец месяца графика — раньше запроса к вебаппу: иначе при
                // лежащем вебаппе строка возвращалась бы каждую минуту вечно.
                if (now.getTime() >= monthAfter(msg.targetMonth)) {
                    await trackedMessageRepository.stopTracking(msg.id);
                    continue;
                }
                const schedule = await preferencesScheduleFor(msg.targetMonth, schedules);
                if (schedule === null) continue;
                // Закрытие необратимо (личное окно открывает «Reopen», а не
                // рассылка) — напоминания кончаются насовсем.
                if (!schedule.open) {
                    await trackedMessageRepository.stopTracking(msg.id);
                    continue;
                }
                // Срок прошёл, но владелец ещё может его продлить — проверяем
                // раз в час, а не бросаем: остановленное напоминание после
                // продления уже не проснулось бы.
                if (now.getTime() >= new Date(schedule.deadlineEndsAt).getTime()) {
                    await trackedMessageRepository.update(msg.id, {
                        nextPingAt: new Date(now.getTime() + DEADLINE_RECHECK_MS),
                    });
                    continue;
                }
                text = STAFF_TEXTS["staff-preferences-reminder"]({
                    monthName: monthNameFromCanonical(msg.targetMonth) ?? "наступний місяць",
                    deadline: formatLocalDate(schedule.deadline),
                });
            } else if (isPrivate && isPreferences) {
                text = STAFF_TEXTS["staff-preferences-reminder-undated"];
            } else if (isPrivate) {
                text = `🔔 <b>Нагадування!</b>\nНатисни кнопку «Підтвердити» у повідомленні вище 👆`;
            } else {
                // Group chat reminder with mentions
                const mentions = activePendingReplies.map((p: any) => {
                    const user = p.user;
                    if (user.username) return `@${escapeHtml(user.username)}`;
                    return `<a href="tg://user?id=${user.telegramId}">${escapeHtml(user.firstName || 'User')}</a>`;
                }).join(", ");

                text = `🔔 <b>Нагадування!</b>\nПрохання підтвердити ознайомлення з повідомленням вище 👆\n\nНе відповіли: ${mentions}`;
            }

            // 3. Delete old ping
            if (msg.lastPingMsgId) {
                try {
                    await bot.api.deleteMessage(Number(msg.chatId), msg.lastPingMsgId);
                } catch (e) {
                    logger.warn({ err: e, chatId: msg.chatId, trackedMessageId: msg.id }, "Previous ping deletion failed");
                }
            }

            // 4. Build keyboard for ping
            const kb = new InlineKeyboard();

            if (isPreferences) {
                kb.text("🗓 Заповнити зараз", "pref_fill");
            } else {
                kb.text("✅ Ознайомлена", `broadcast_confirm_ok_${msg.broadcastId}`);
            }

            // 5. Send new ping
            try {
                const sentPing = await bot.api.sendMessage(Number(msg.chatId), text, {
                    reply_to_message_id: msg.messageId,
                    parse_mode: "HTML",
                    reply_markup: kb
                });

                // 6. Update tracking info
                const nextPingInterval = msg.pingIntervalMs || PING_CONFIG.REPEAT_DELAY_MS;
                // Следующий пинг тоже сдвигается за пределы ночи: 18:00 плюс
                // шесть часов — это полночь, и без переноса напоминание всё
                // равно ушло бы ночью, просто на один тик позже.
                await trackedMessageRepository.update(msg.id, {
                    lastPingMsgId: sentPing.message_id,
                    nextPingAt: nextAllowedPingTime(new Date(Date.now() + nextPingInterval))
                });

                logBusinessEvent({
                    event: "broadcast.ping_sent",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "pinger",
                    operation: "runPinger",
                    safeContext: {
                        trackedMessageId: msg.id,
                        chatId: msg.chatId,
                        messageId: msg.messageId,
                        pendingReplies: activePendingReplies.length,
                    },
                });
            } catch (e: any) {
                if (e.error_code === 403 || (e.error_code === 400 && e.description?.includes("chat not found"))) {
                    await trackedMessageRepository.stopTracking(msg.id);
                    // Only treat as intentional block if we already pinged at least once before
                    // (msg.lastPingMsgId exists = at least one prior ping was delivered)
                    const chatId = Number(msg.chatId);
                    if (chatId > 0 && msg.lastPingMsgId) {
                        await handleBlockedUser(bot, chatId);
                    } else {
                        logger.warn({ chatId: msg.chatId, trackedMessageId: msg.id }, "Ping tracking stopped because chat is blocked or missing");
                    }
                    logBusinessEvent({
                        event: "broadcast.ping_tracking.stopped",
                        level: "warn",
                        actorType: "system",
                        actorRole: "system",
                        result: "stopped",
                        reasonCode: "CHAT_BLOCKED_OR_NOT_FOUND",
                        module: "pinger",
                        operation: "runPinger",
                        safeContext: {
                            trackedMessageId: msg.id,
                            chatId: msg.chatId,
                            messageId: msg.messageId,
                        },
                        error: e,
                    });
                } else if (e.error_code === 400 && e.description?.includes("message to be replied not found")) {
                    logger.warn({ chatId: msg.chatId, trackedMessageId: msg.id, messageId: msg.messageId }, "Ping tracking stopped because original message was not found");
                    await trackedMessageRepository.stopTracking(msg.id);
                    logBusinessEvent({
                        event: "broadcast.ping_tracking.stopped",
                        level: "warn",
                        actorType: "system",
                        actorRole: "system",
                        result: "stopped",
                        reasonCode: "ORIGINAL_MESSAGE_NOT_FOUND",
                        module: "pinger",
                        operation: "runPinger",
                        safeContext: {
                            trackedMessageId: msg.id,
                            chatId: msg.chatId,
                            messageId: msg.messageId,
                        },
                        error: e,
                    });
                } else {
                    logger.error({ err: e, chatId: msg.chatId, trackedMessageId: msg.id }, "Ping delivery failed");
                    logBusinessEvent({
                        event: "broadcast.ping_sent",
                        level: "error",
                        actorType: "system",
                        actorRole: "system",
                        result: "failed",
                        reasonCode: "PING_SEND_FAILED",
                        module: "pinger",
                        operation: "runPinger",
                        safeContext: {
                            trackedMessageId: msg.id,
                            chatId: msg.chatId,
                            messageId: msg.messageId,
                        },
                        error: e,
                    });
                }
            }
        }
    } catch (e) {
        logger.error({ err: e }, "Pinger loop iteration failed");
        logBusinessEvent({
            event: "broadcast.pinger_loop.failed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            module: "pinger",
            operation: "runPinger",
            error: e,
        });
    }
}
