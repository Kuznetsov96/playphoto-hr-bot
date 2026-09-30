import { PrismaClient, CandidateStatus, FunnelStep } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { CANDIDATE_TEXTS } from "../constants/candidate-texts.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { isBotBlocked, handleBlockedCandidate } from "../utils/bot-blocked.js";

const prisma = new PrismaClient();

const TEXT_24H_PING = `<b>Запрошення на співбесіду ще діє</b>\n\nВільні місця швидко закінчуються. Якщо ви не оберете час до кінця дня, місце перейде наступному кандидату в черзі.`;

const TEXT_48H_RESET = `<b>Термін дії запрошення минув</b>\n\nМісце перейшло іншому кандидату, а вашу анкету ми повернули в резерв. Щойно з'являться нові вакансії — ми напишемо.`;

/**
 * Checks candidates invited to interview.
 * - 24 hours: sends ping message.
 * - 48 hours: resets them to waitlist.
 */
export async function processInviteReminders(bot: any) {
    logBusinessEvent({
        event: "candidate.invite_reminder_scan.started",
        actorType: "system",
        actorRole: "system",
        result: "started",
        module: "invite-reminder-worker",
        operation: "processInviteReminders",
    });

    try {
        const now = new Date();
        const pingThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
        const resetThreshold = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago

        // We only care about candidates in SCREENING who have been notified but haven't booked
        const pendingCandidates = await prisma.candidate.findMany({
            where: {
                status: CandidateStatus.SCREENING,
                notificationSent: true,
                interviewInvitedAt: { not: null },
                interviewSlotId: null, // Haven't booked yet
            },
            include: { user: true }
        });

        let resetCount = 0;
        let pingCount = 0;

        for (const cand of pendingCandidates) {
            if (!cand.interviewInvitedAt) continue;

            const invitedTime = cand.interviewInvitedAt.getTime();

            // Check if older than 48 hours -> Reset
            if (invitedTime <= resetThreshold.getTime()) {
                await candidateRepository.update(cand.id, {
                    status: CandidateStatus.WAITLIST_HR,
                    isWaitlisted: true,
                    // Назад у резерв, а не в пошук часу: інакше екран статусу
                    // знову пропонував би «Обрати час» тій, кому щойно написали,
                    // що місце перейшло іншій.
                    currentStep: FunnelStep.INITIAL_TEST,
                    notificationSent: false, // Reset to allow future invites
                    interviewInvitedAt: null, // Reset time
                    interviewInviteReminderSentAt: null,
                });

                try {
                    await bot.api.sendMessage(Number(cand.user.telegramId), TEXT_48H_RESET, { parse_mode: "HTML" });
                } catch (e: any) {
                    if (isBotBlocked(e)) {
                        await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                    }
                }
                resetCount += 1;

            }
            // Старше суток, но ещё не 48 часов: одно напоминание. Однократность
            // держит отметка, а не окно по времени — вокер крутится каждые
            // 5 минут, и часовое окно давало около 12 напоминаний подряд.
            else if (invitedTime <= pingThreshold.getTime() && !cand.interviewInviteReminderSentAt) {
                try {
                    await bot.api.sendMessage(Number(cand.user.telegramId), TEXT_24H_PING, {
                        parse_mode: "HTML",
                        reply_markup: new InlineKeyboard()
                            .text(CANDIDATE_TEXTS["candidate-btn-choose-time"], "start_scheduling").row()
                            .text(CANDIDATE_TEXTS["candidate-btn-invite-decline"], "decline_invite").danger()
                    });
                    await candidateRepository.update(cand.id, { interviewInviteReminderSentAt: new Date() });
                    pingCount += 1;
                } catch (e: any) {
                    if (isBotBlocked(e)) {
                        await handleBlockedCandidate(bot.api, cand.id, cand.fullName || "Candidate");
                    }
                }
            }
        }
        logBusinessEvent({
            event: "candidate.invite_reminder_scan.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "invite-reminder-worker",
            operation: "processInviteReminders",
            safeContext: {
                candidateCount: pendingCandidates.length,
                resetCount,
                pingCount,
            },
        });
    } catch (e: any) {
        logger.error({ err: e }, "❌ [WORKER] Failed to process invite reminders.");
    }
}
