import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { trackedMessageRepository } from "../repositories/tracked-message-repository.js";
import { broadcastRepository } from "../repositories/broadcast-repository.js";
import { broadcastActionRepository } from "../repositories/broadcast-action-repository.js";
import { broadcastPingLogRepository } from "../repositories/broadcast-ping-log-repository.js";
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
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { surnameAndName } from "../utils/person-name.js";
import { formatLocalDate } from "../utils/format-deadline.js";
import { awsBusinessClient, type SchedulePreferenceSchedule } from "./aws-business-client.js";
import { enqueueAnnouncementSyncSafe, processAnnouncementSync } from "./announcement-sync.js";
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

async function handleBlockedUser(bot: BotLike, telegramId: number) {
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
                    const text = ADMIN_TEXTS["admin-notif-staff-blocked"]({ name: escapeHtml(surnameAndName(staffName)) });
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
                const text = ADMIN_TEXTS["admin-notif-staff-blocked-offboarded"]({ name: escapeHtml(surnameAndName(staffName)) });
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

async function pruneNonMembersFromPending(msg: any, bot: BotLike) {
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
        // История не теряется: строка остаётся со статусом 'dropped' и больше нигде не считается.
        await pendingReplyRepository.updateMany({ id: { in: stalePendingIds } }, { status: "dropped" });
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

/**
 * Кто на месяц ещё не подал — по вебаппу, один запрос на прогон. `null` —
 * вебапп недоступен. Нужен, потому что подать можно и мимо бота: владелец
 * вписывает пожелания за человека на экране Availability, а ожидание ответа в
 * боте об этом не знает и напоминание пришло бы тому, у кого всё уже подано.
 */
async function missingFor(
    month: string,
    cache: Map<string, Set<string> | null>,
): Promise<Set<string> | null> {
    if (cache.has(month)) return cache.get(month)!;
    let missing: Set<string> | null = null;
    try {
        const result = await awsBusinessClient.missingSchedulePreferences(month);
        missing = new Set(result.items.map((item) => item.telegramId));
    } catch (error) {
        logger.warn({ err: error, month }, "Missing-preferences list unavailable; reminders wait for the next tick");
    }
    cache.set(month, missing);
    return missing;
}

/** Остановка напоминаний по сообщению + синк рассылки в вебапп. */
async function stopTrackingAndSync(msg: { id: number; broadcastId: number }) {
    await trackedMessageRepository.stopTracking(msg.id);
    await enqueueAnnouncementSyncSafe(msg.broadcastId);
}

type BotLike = Pick<Bot<MyContext>, "api">;

/** Итог одного напоминания: `stopped` — чат закрыт/сообщения нет, напоминать там больше нечего. */
export type ReminderOutcome = "sent" | "skipped" | "stopped" | "failed";

interface ReminderCaches {
    schedules: Map<string, SchedulePreferenceSchedule | null>;
    missingByMonth: Map<string, Set<string> | null>;
}

const newReminderCaches = (): ReminderCaches => ({ schedules: new Map(), missingByMonth: new Map() });

/**
 * Одно напоминание в один чат (шаги 1-6 цикла). Автонапоминание
 * (`manual: false`) двигает расписание `nextPingAt` и сворачивает отслеживание,
 * когда ждать некого. Ручное (`manual: true`, команда «Remind» из вебаппа)
 * расписания не трогает вовсе, так что рассылка без автонапоминаний сама
 * напоминать не начинает; шлёт то же сообщение и пишет ту же историю.
 */
export async function sendReminder(
    bot: BotLike,
    msg: any,
    activePendingReplies: any[],
    now: Date,
    opts: { manual: boolean; caches?: ReminderCaches; actorName?: string | null } = { manual: false },
): Promise<ReminderOutcome> {
    const manual = opts.manual;
    const schedules = (opts.caches ??= newReminderCaches()).schedules;
    const missingByMonth = opts.caches.missingByMonth;
    // 1. If no pending replies, stop pinging
    if (activePendingReplies.length === 0) {
        // Ручное напоминание расписание автонапоминаний не трогает: некому слать — и всё.
        if (manual) return "skipped";
        await stopTrackingAndSync(msg);
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
        return "skipped";
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
            if (!manual) await stopTrackingAndSync(msg);
            return "skipped";
        }
        const schedule = await preferencesScheduleFor(msg.targetMonth, schedules);
        // Вебапп недоступен — это неудача, а не «слать нечего»: ручное напоминание повторится.
        if (schedule === null) return "failed";
        // Закрытие необратимо (личное окно открывает «Reopen», а не
        // рассылка) — напоминания кончаются насовсем.
        if (!schedule.open) {
            if (!manual) await stopTrackingAndSync(msg);
            return "skipped";
        }
        // Срок прошёл, но владелец ещё может его продлить — проверяем
        // раз в час, а не бросаем: остановленное напоминание после
        // продления уже не проснулось бы.
        if (now.getTime() >= new Date(schedule.deadlineEndsAt).getTime()) {
            if (!manual) {
                await trackedMessageRepository.update(msg.id, {
                    nextPingAt: new Date(now.getTime() + DEADLINE_RECHECK_MS),
                });
            }
            return "skipped";
        }
        const missing = await missingFor(msg.targetMonth, missingByMonth);
        if (missing === null) return "failed";
        // Подано мимо бота (владелец вписал) — закрываем ожидание, как
        // это сделало бы сохранение в боте, и больше не напоминаем.
        if (!missing.has(String(msg.chatId))) {
            if (!manual) {
                await pendingReplyRepository.updateMany(
                    { trackedMessageId: msg.id, status: "pending" },
                    { status: "confirmed", respondedAt: now },
                );
                await stopTrackingAndSync(msg);
            }
            return "skipped";
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

    // Пока задача ждала очереди, рассылку могли отозвать или остановить: свежее состояние читаем
    // прямо перед отправкой. Остаток окна в доли секунды принят: цена — одно лишнее напоминание.
    const state = await broadcastRepository.findReminderState(msg.broadcastId);
    if (state?.withdrawnAt || state?.remindersStoppedAt) return "skipped";

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
    let delivered = false;
    try {
        const sentPing = await bot.api.sendMessage(Number(msg.chatId), text, {
            reply_to_message_id: msg.messageId,
            parse_mode: "HTML",
            reply_markup: kb
        });
        delivered = true;

        // 6. Update tracking info
        const nextPingInterval = msg.pingIntervalMs || PING_CONFIG.REPEAT_DELAY_MS;
        // Следующий пинг тоже сдвигается за пределы ночи: 18:00 плюс
        // шесть часов — это полночь, и без переноса напоминание всё
        // равно ушло бы ночью, просто на один тик позже.
        // Ручное напоминание расписание не двигает: рассылка без
        // автонапоминаний от него автонапоминаний не получает.
        await trackedMessageRepository.update(msg.id, manual
            ? { lastPingMsgId: sentPing.message_id }
            : {
                lastPingMsgId: sentPing.message_id,
                nextPingAt: nextAllowedPingTime(new Date(Date.now() + nextPingInterval))
            });

        // История рассылки: пинг записан, даже если запись не удалась — не
        // ломаем отправку остальным.
        await broadcastPingLogRepository.create(msg.broadcastId, BigInt(msg.chatId), {
            messageId: sentPing.message_id,
            actorName: manual ? (opts.actorName ?? null) : null,
        }).catch(err => {
            logger.warn({ err, broadcastId: msg.broadcastId }, "Failed to record broadcast ping");
        });
        await enqueueAnnouncementSyncSafe(msg.broadcastId);

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
        return "sent";
    } catch (e: any) {
        // Сообщение уже ушло, упала запись после него: повторять нельзя, иначе человек получит второе.
        if (delivered) {
            logger.error({ err: e, chatId: msg.chatId, trackedMessageId: msg.id }, "Ping bookkeeping failed after delivery");
            return "sent";
        }
        if (e.error_code === 403 || (e.error_code === 400 && e.description?.includes("chat not found"))) {
            await stopTrackingAndSync(msg);
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
            return "stopped";
        } else if (e.error_code === 400 && e.description?.includes("message to be replied not found")) {
            logger.warn({ chatId: msg.chatId, trackedMessageId: msg.id, messageId: msg.messageId }, "Ping tracking stopped because original message was not found");
            await stopTrackingAndSync(msg);
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
            return "stopped";
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
    return "failed";
}

/**
 * Ручное напоминание («Remind» из вебаппа): каждому чату, где ещё есть
 * неответившие, ровно одно сообщение на действие. Отметка ставится ДО отправки
 * и снимается, только если отправка не состоялась, поэтому повтор команды
 * (лиз вернулся после частичной отправки) никому не шлёт второе. Расписание
 * автонапоминаний не меняется.
 */
export async function remindBroadcast(
    bot: BotLike,
    broadcastId: number,
    actionPublicId: string,
    now: Date = new Date(),
    actorName: string | null = null,
): Promise<{ sent: number; failed: number }> {
    const tracked = await trackedMessageRepository.findForManualRemind(broadcastId);
    const caches = newReminderCaches();
    let sent = 0;
    let failed = 0;
    for (const msg of tracked) {
        const pending = await pruneNonMembersFromPending(msg, bot);
        if (pending.length === 0) continue;
        const chatId = BigInt(msg.chatId);
        if (!(await broadcastActionRepository.claimReminderMark(broadcastId, chatId, actionPublicId))) continue;
        const outcome = await sendReminder(bot, msg, pending, now, { manual: true, caches, actorName });
        if (outcome === "sent") sent++;
        else if (outcome === "failed") failed++;
        if (outcome === "failed" || outcome === "skipped") {
            await broadcastActionRepository.releaseReminderMark(chatId, actionPublicId);
        }
    }
    return { sent, failed };
}

/** Сколько тиков отложенное ручное напоминание пробуют доставить чатам с временной ошибкой. */
const MANUAL_REMIND_MAX_ATTEMPTS = 3;

/**
 * Тик ручных напоминаний, отложенных на утро: берёт рассылки с
 * `manualRemindAt <= now`, вне тихих часов шлёт и закрывает действие. Один
 * проход: сбой отдельного чата не держит рассылку в очереди вечно.
 */
async function runManualReminders(bot: BotLike, now: Date) {
    if (isQuietHour(now)) return;
    const due = await broadcastRepository.findDueManualReminders(now);
    for (const broadcast of due) {
        try {
            const actionId = broadcast.manualRemindActionId;
            // Снята или остановлена после постановки: не шлём, но действие закрываем и очередь чистим.
            const closed = broadcast.withdrawnAt !== null || broadcast.remindersStoppedAt !== null;
            if (actionId && !closed && !(await broadcastActionRepository.findLog(actionId))) {
                const { failed } = await remindBroadcast(bot, broadcast.id, actionId, now, broadcast.manualRemindActorName);
                if (failed > 0) {
                    // Временная ошибка не должна терять напоминание: чаты без отметки досылаются на следующем
                    // тике, но не больше MANUAL_REMIND_MAX_ATTEMPTS раз за действие.
                    const attempts = await broadcastActionRepository.bumpAttempts(broadcast.id, actionId);
                    if (attempts < MANUAL_REMIND_MAX_ATTEMPTS) {
                        logger.warn({ broadcastId: broadcast.id, failed, attempts }, "Deferred manual reminder had failed chats; will retry on the next tick");
                        continue;
                    }
                    logger.warn({ broadcastId: broadcast.id, failed, attempts }, "Deferred manual reminder gave up after repeated failures");
                }
            }
            if (actionId) await broadcastActionRepository.markDone(actionId, broadcast.id, "REMIND");
            // Вебапп переписывает «Reminder requested» в «scheduled for…» только по снимку, где действие
            // закрыто и manualRemindAt ещё стоит, поэтому этот снимок уходит до сброса поля.
            await processAnnouncementSync(broadcast.id).catch(err => {
                logger.warn({ err, broadcastId: broadcast.id }, "Snapshot of the fired deferred reminder failed");
            });
            await broadcastRepository.update(broadcast.id, { manualRemindAt: null, manualRemindActionId: null, manualRemindActorName: null });
            await enqueueAnnouncementSyncSafe(broadcast.id);
        } catch (e) {
            logger.error({ err: e, broadcastId: broadcast.id }, "Deferred manual reminder failed");
        }
    }
}

async function runPinger(bot: Bot<MyContext>) {
    try {
        const now = new Date();
        await runManualReminders(bot, now).catch(e => logger.error({ err: e }, "Manual reminders tick failed"));
        const messagesToPing = await trackedMessageRepository.findToPing(now);
        const caches = newReminderCaches();

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
                // «Следующее напоминание» в вебаппе берётся из nextPingAt.
                await enqueueAnnouncementSyncSafe(msg.broadcastId);
                continue;
            }

            await sendReminder(bot, msg, activePendingReplies, now, { manual: false, caches });
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
