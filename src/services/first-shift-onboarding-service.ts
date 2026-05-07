import type { Api, Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { Prisma, type FirstShiftOnboardingStep } from "@prisma/client";
import { FirstShiftOnboardingInputType } from "@prisma/client";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { FIRST_SHIFT_ONBOARDING_CHAT_ID } from "../config.js";
import { FIRST_SHIFT_ONBOARDING_STEPS, FIRST_SHIFT_ONBOARDING_TEXTS } from "../constants/first-shift-onboarding-texts.js";
import { firstShiftOnboardingRepository, type FirstShiftOnboardingCaseWithRelations } from "../repositories/first-shift-onboarding-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { timelineRepository } from "../repositories/timeline-repository.js";
import { logBusinessEvent } from "../core/log-events.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { getShiftTimeFromLocationSchedule } from "../utils/shift-time.js";
import { createKyivDate } from "../utils/bot-utils.js";

const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSING", "PENDING_FINAL"] as const;
const CLOSING_BLOCK = "Закриття зміни";
const ENTRY_MESSAGE_LEASE_MS = 10 * 60 * 1000;
const CLOSING_OPEN_LEAD_MS = 30 * 60 * 1000;

export type FirstShiftOnboardingCandidateMessage = {
    text?: string;
    photoId?: string | null;
    messageId?: number;
    chatId?: number;
    hasCopyableOriginal?: boolean;
};

export class FirstShiftOnboardingService {
    async findActiveCaseByTelegramId(telegramId: number) {
        const candidate = await prisma.candidate.findFirst({
            where: { user: { telegramId: BigInt(telegramId) } },
        });
        if (!candidate) return null;
        return firstShiftOnboardingRepository.findActiveCaseByCandidateId(candidate.id);
    }

    async ensureCase(candidateId: string) {
        const existing = await firstShiftOnboardingRepository.findCaseByCandidateId(candidateId);
        if (existing) return existing;

        const steps = FIRST_SHIFT_ONBOARDING_STEPS.map((step, index) => ({
            key: step.key,
            block: step.block,
            title: step.title,
            prompt: step.prompt,
            order: index + 1,
            inputType: step.inputType,
            requiresMentorApproval: step.requiresMentorApproval ?? true,
            status: index === 0 ? "ACTIVE" as const : "LOCKED" as const,
        }));

        try {
            return await firstShiftOnboardingRepository.createCase(candidateId, steps);
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                const concurrent = await firstShiftOnboardingRepository.findCaseByCandidateId(candidateId);
                if (concurrent) return concurrent;
            }
            throw err;
        }
    }

    async openCaseForCandidate(api: Api, candidateId: string) {
        const onboardingCase = await this.ensureCase(candidateId);
        if (!FIRST_SHIFT_ONBOARDING_CHAT_ID) {
            logger.warn({ candidateId }, "FIRST_SHIFT_ONBOARDING_CHAT_ID is not configured; first-shift onboarding topic was not opened");
            return onboardingCase;
        }

        if (onboardingCase.topicId && onboardingCase.chatId) {
            return onboardingCase;
        }

        const candidate = onboardingCase.candidate;
        const surname = (candidate.fullName || candidate.user.firstName || "Candidate").trim().split(/\s+/)[0] || "Candidate";
        const location = candidate.location?.name || candidate.city || "No location";
        const date = this.formatDate(candidate.firstShiftDate);
        const topic = await api.createForumTopic(FIRST_SHIFT_ONBOARDING_CHAT_ID, `🚀 ONB | ${surname} | ${location} | ${date}`);

        const updated = await firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            chatId: BigInt(FIRST_SHIFT_ONBOARDING_CHAT_ID),
            topicId: topic.message_thread_id,
        });

        return this.syncStatusCard(api, updated);
    }

    async notifyCandidate(api: Api, candidateId: string) {
        const onboardingCase = await this.openCaseForCandidate(api, candidateId);
        if (onboardingCase.entryMessageSentAt) {
            return onboardingCase;
        }

        const now = new Date();
        const leaseUntil = new Date(now.getTime() + ENTRY_MESSAGE_LEASE_MS);
        const claimed = await firstShiftOnboardingRepository.claimEntryMessageDelivery(onboardingCase.id, now, leaseUntil);
        if (!claimed) {
            return (await firstShiftOnboardingRepository.findCaseByCandidateId(candidateId)) || onboardingCase;
        }

        let deliveredCase: FirstShiftOnboardingCaseWithRelations | null = null;
        try {
            await this.sendEntryMessage(api, onboardingCase);
            deliveredCase = await firstShiftOnboardingRepository.markEntryMessageDelivered(onboardingCase.id, new Date());
        } catch (err) {
            await firstShiftOnboardingRepository.releaseEntryMessageDelivery(onboardingCase.id).catch(() => undefined);
            throw err;
        }

        logBusinessEvent({
            event: "first_shift_onboarding.candidate_notified",
            actorType: "system",
            result: "success",
            module: "first-shift-onboarding",
            candidateId,
            safeContext: { caseId: deliveredCase.id, topicId: deliveredCase.topicId },
        });

        return deliveredCase;
    }

    async resumeCandidateFlowFromStart(api: Api, telegramId: number) {
        const candidate = await candidateRepository.findByTelegramId(telegramId);
        if (!candidate) return false;

        const onboardingCase = await firstShiftOnboardingRepository.findActiveCaseByCandidateId(candidate.id);
        if (!onboardingCase) return false;

        if (onboardingCase.status === "OPEN") {
            await this.notifyCandidate(api, candidate.id);
            return true;
        }

        if (onboardingCase.status === "PENDING_FINAL") {
            await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.waitingFinal, { parse_mode: "HTML" });
            return true;
        }

        await this.sendCurrentStepToCandidate(api, onboardingCase);
        return true;
    }

    async startCandidateFlow(api: Api, caseId: string, telegramId: number) {
        const onboardingCase = await this.getCaseForCandidateCallback(caseId, telegramId);
        if (!onboardingCase) return null;

        const started = await firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            status: "IN_PROGRESS",
            startedAt: onboardingCase.startedAt || new Date(),
            currentStepKey: onboardingCase.currentStepKey || this.getCurrentStep(onboardingCase)?.key || null,
        });

        await this.sendCurrentStepToCandidate(api, started);
        await this.postTopicStatus(api, started, FIRST_SHIFT_ONBOARDING_TEXTS.topicStarted);
        return started;
    }

    async submitButtonStep(api: Api, caseId: string, telegramId: number) {
        const onboardingCase = await this.getCaseForCandidateCallback(caseId, telegramId);
        if (!onboardingCase) return null;
        const step = this.getCurrentStep(onboardingCase);
        if (!step || !this.canCandidateSubmitByButton(step)) return null;
        return this.submitStep(api, onboardingCase, step, { text: "Кандидат підтвердила виконання." });
    }

    async finishMultiplePhotos(api: Api, caseId: string, telegramId: number) {
        const onboardingCase = await this.getCaseForCandidateCallback(caseId, telegramId);
        if (!onboardingCase) return null;
        const step = this.getCurrentStep(onboardingCase);
        if (!step || step.inputType !== FirstShiftOnboardingInputType.MULTIPLE_PHOTOS) return null;
        if (!step.photoIds) {
            await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.sendPhotoExpected, { parse_mode: "HTML" });
            return onboardingCase;
        }
        return this.submitStep(api, onboardingCase, step, { text: "Усі фото надіслано." });
    }

    async handleCandidateMessage(api: Api, telegramId: number, message: FirstShiftOnboardingCandidateMessage) {
        const onboardingCase = await this.findActiveCaseByTelegramId(telegramId);
        if (!onboardingCase) return false;

        const step = this.getCurrentStep(onboardingCase);
        if (!step) {
            const label = onboardingCase.status === "PENDING_FINAL"
                ? "💬 Повідомлення від фотографа під час очікування фінального рішення"
                : "💬 Повідомлення від фотографа";
            const replyText = onboardingCase.status === "PENDING_FINAL"
                ? `${FIRST_SHIFT_ONBOARDING_TEXTS.waitingFinal}\n\n${FIRST_SHIFT_ONBOARDING_TEXTS.questionForwarded}`
                : FIRST_SHIFT_ONBOARDING_TEXTS.questionForwarded;

            await this.forwardCandidateMessageToTopic(api, onboardingCase, message, label);
            await api.sendMessage(telegramId, replyText, { parse_mode: "HTML" });
            return true;
        }

        if (step.status === "SUBMITTED") {
            await this.forwardCandidateMessageToTopic(api, onboardingCase, message, "💬 Повідомлення від фотографа під час очікування підтвердження");
            await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.questionForwarded, { parse_mode: "HTML" });
            return true;
        }

        if (step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            await firstShiftOnboardingRepository.updateStep(step.id, {
                status: "SUBMITTED",
                submittedText: message.text || step.submittedText || null,
                submittedAt: new Date(),
            });

            const submittedStep = {
                ...step,
                status: "SUBMITTED",
                submittedText: message.text || step.submittedText || null,
            } as FirstShiftOnboardingStep;

            await this.forwardCandidateMessageToTopic(api, onboardingCase, message, `📤 ${step.block}: ${step.title}`, submittedStep);
            const refreshedCase = await firstShiftOnboardingRepository.findActiveCaseByCandidateId(onboardingCase.candidateId);
            if (refreshedCase) {
                await this.syncStatusCard(api, refreshedCase);
            }
            await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.submitted, { parse_mode: "HTML" });
            return true;
        }

        if (this.isPhotoInput(step.inputType)) {
            if (!message.photoId) {
                if (message.text) {
                    await this.forwardCandidateMessageToTopic(api, onboardingCase, message, "💬 Питання від фотографа");
                    await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.questionForwarded, { parse_mode: "HTML" });
                    return true;
                }
                if (message.hasCopyableOriginal) {
                    await this.forwardCandidateMessageToTopic(api, onboardingCase, message, "💬 Повідомлення від фотографа");
                    await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.questionForwarded, { parse_mode: "HTML" });
                    return true;
                }
                await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.sendPhotoExpected, { parse_mode: "HTML" });
                return true;
            }

            const photoIds = step.photoIds ? step.photoIds.split(",").filter(Boolean) : [];
            photoIds.push(message.photoId);
            await firstShiftOnboardingRepository.updateStep(step.id, {
                photoIds: photoIds.join(","),
                submittedAt: new Date(),
                status: step.inputType === FirstShiftOnboardingInputType.MULTIPLE_PHOTOS ? "ACTIVE" : "SUBMITTED",
            });

            const refreshedCase = await firstShiftOnboardingRepository.findActiveCaseByCandidateId(onboardingCase.candidateId);
            if (step.inputType === FirstShiftOnboardingInputType.MULTIPLE_PHOTOS) {
                await this.copyOriginalMessageToTopic(api, onboardingCase, message, `📷 Фото до кроку: ${step.block}: ${step.title}`);
            } else {
                await this.forwardCandidateMessageToTopic(
                    api,
                    onboardingCase,
                    message,
                    `📤 ${step.block}: ${step.title}`,
                    {
                        ...step,
                        status: "SUBMITTED",
                    } as FirstShiftOnboardingStep
                );
            }

            if (refreshedCase && step.inputType !== FirstShiftOnboardingInputType.MULTIPLE_PHOTOS) {
                await this.syncStatusCard(api, refreshedCase);
            }

            if (step.inputType === FirstShiftOnboardingInputType.MULTIPLE_PHOTOS) {
                await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.multiplePhotosHint, {
                    parse_mode: "HTML",
                    reply_markup: new InlineKeyboard().text(FIRST_SHIFT_ONBOARDING_TEXTS.multiplePhotosDoneButton, `fso_done_${onboardingCase.id}`),
                });
                return true;
            }

            await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.submitted, { parse_mode: "HTML" });
            return true;
        }

        if (this.isTextInput(step.inputType)) {
            if (!message.text) {
                await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.sendTextExpected, { parse_mode: "HTML" });
                return true;
            }
            await this.submitStep(api, onboardingCase, step, { text: message.text });
            return true;
        }

        await this.forwardCandidateMessageToTopic(api, onboardingCase, message, "💬 Повідомлення від фотографа");
        return true;
    }

    async approveStep(api: Api, stepId: string, mentorTelegramId?: number) {
        const onboardingCase = await this.findActiveCaseByStepId(stepId);
        if (!onboardingCase) return null;
        const step = onboardingCase.steps.find(s => s.id === stepId);
        if (!step) return null;
        const currentStep = this.getCurrentStep(onboardingCase);

        if (currentStep?.id !== stepId || !this.canMentorResolveStep(step)) {
            logger.warn({
                stepId,
                mentorTelegramId,
                caseId: onboardingCase.id,
                currentStepId: currentStep?.id || null,
                currentStepKey: currentStep?.key || null,
                stepStatus: step.status,
                stepInputType: step.inputType,
            }, "Ignored invalid first-shift onboarding approve action");
            return null;
        }

        await firstShiftOnboardingRepository.updateStep(step.id, {
            status: "APPROVED",
            approvedAt: new Date(),
            completedAt: new Date(),
        });

        return this.advanceFromResolvedStep(api, onboardingCase, step, FIRST_SHIFT_ONBOARDING_TEXTS.approved, "✅ Step approved.");
    }

    private async advanceFromResolvedStep(
        api: Api,
        onboardingCase: FirstShiftOnboardingCaseWithRelations,
        step: FirstShiftOnboardingStep,
        candidateMessage?: string,
        topicMessage?: string,
    ) {

        const refreshed = await firstShiftOnboardingRepository.findActiveCaseByCandidateId(onboardingCase.candidateId);
        if (!refreshed) return null;
        const next = this.getNextStep(refreshed, step.order);

        if (!next) {
            const pending = await firstShiftOnboardingRepository.updateCase(refreshed.id, {
                status: "PENDING_FINAL",
                currentStepKey: null,
            });
            await api.sendMessage(Number(pending.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.waitingFinal, { parse_mode: "HTML" });
            await this.postTopicStatus(api, pending, this.buildFinalReviewText(pending), this.buildFinalKeyboard(pending));
            return pending;
        }

        if (next.block === CLOSING_BLOCK && !this.canOpenClosingNow(refreshed)) {
            const paused = await firstShiftOnboardingRepository.updateCase(refreshed.id, {
                status: "IN_PROGRESS",
                currentStepKey: null,
            });
            await api.sendMessage(Number(paused.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.setupCompleted, { parse_mode: "HTML" });
            await this.postTopicStatus(api, paused, FIRST_SHIFT_ONBOARDING_TEXTS.topicSetupCompleted, this.buildMentorCaseKeyboard(paused));
            return paused;
        }

        await firstShiftOnboardingRepository.updateStep(next.id, { status: "ACTIVE" });
        const updated = await firstShiftOnboardingRepository.updateCase(refreshed.id, {
            currentStepKey: next.key,
            status: next.block === CLOSING_BLOCK ? "CLOSING" : "IN_PROGRESS",
        });

        if (candidateMessage) {
            await api.sendMessage(Number(updated.candidate.user.telegramId), candidateMessage, { parse_mode: "HTML" });
        }
        await this.sendCurrentStepToCandidate(api, updated);
        if (topicMessage) {
            await this.postTopicStatus(api, updated, topicMessage);
        }
        return updated;
    }

    async openClosing(api: Api, caseId: string) {
        const onboardingCase = await prisma.firstShiftOnboardingCase.findUnique({
            where: { id: caseId },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as FirstShiftOnboardingCaseWithRelations | null;
        if (!onboardingCase || !ACTIVE_STATUSES.includes(onboardingCase.status as any)) return null;

        const closingStep = onboardingCase.steps.find(step => step.block === CLOSING_BLOCK && !["APPROVED", "SKIPPED"].includes(step.status));
        if (!closingStep) return null;

        await firstShiftOnboardingRepository.updateStep(closingStep.id, { status: "ACTIVE" });
        const updated = await firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            status: "CLOSING",
            currentStepKey: closingStep.key,
        });

        await api.sendMessage(Number(updated.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.closingOpened, { parse_mode: "HTML" });
        await this.sendCurrentStepToCandidate(api, updated);
        await this.postTopicStatus(api, updated, FIRST_SHIFT_ONBOARDING_TEXTS.topicClosingOpened);
        return updated;
    }

    async rejectStep(api: Api, stepId: string, comment?: string | null) {
        const onboardingCase = await this.findActiveCaseByStepId(stepId);
        if (!onboardingCase) return null;
        const step = onboardingCase.steps.find(s => s.id === stepId);
        if (!step) return null;
        const currentStep = this.getCurrentStep(onboardingCase);

        if (currentStep?.id !== stepId || !this.canMentorResolveStep(step)) {
            logger.warn({
                stepId,
                caseId: onboardingCase.id,
                currentStepId: currentStep?.id || null,
                currentStepKey: currentStep?.key || null,
                stepStatus: step.status,
                stepInputType: step.inputType,
            }, "Ignored invalid first-shift onboarding reject action");
            return null;
        }

        await firstShiftOnboardingRepository.updateStep(step.id, {
            status: "REJECTED",
            mentorComment: comment || null,
            submittedText: null,
            photoIds: null,
            rejectedAt: new Date(),
        });
        await firstShiftOnboardingRepository.updateStep(step.id, { status: "ACTIVE" });

        const updated = await firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            currentStepKey: step.key,
        });

        await api.sendMessage(Number(updated.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.rejected(comment), { parse_mode: "HTML" });
        await this.sendCurrentStepToCandidate(api, updated);
        await this.postTopicStatus(api, updated, `🔁 Step returned for redo: ${escapeHtml(step.title)}.${comment ? `\nReason: ${escapeHtml(comment)}` : ""}`);
        return updated;
    }

    async completeCase(api: Api, caseId: string) {
        const onboardingCase = await prisma.firstShiftOnboardingCase.findUnique({
            where: { id: caseId },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as FirstShiftOnboardingCaseWithRelations | null;
        if (!onboardingCase || !ACTIVE_STATUSES.includes(onboardingCase.status as any)) return null;

        const updated = await firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            status: "PASSED",
            completedAt: new Date(),
        });
        await candidateRepository.update(updated.candidate.id, {
            status: "HIRED",
            isMentorLocked: false,
        });
        await api.sendMessage(Number(updated.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.completed, { parse_mode: "HTML" });
        await this.postTopicStatus(api, updated, FIRST_SHIFT_ONBOARDING_TEXTS.topicClosed);
        if (updated.topicId && updated.chatId) {
            await api.closeForumTopic(Number(updated.chatId), updated.topicId).catch(() => undefined);
        }
        await timelineRepository.createEvent(updated.candidate.userId, "SYSTEM_EVENT", "SYSTEM", "First shift onboarding passed", { caseId: updated.id });
        return updated;
    }

    async failCase(api: Api, caseId: string, reason?: string | null) {
        const onboardingCase = await prisma.firstShiftOnboardingCase.findUnique({
            where: { id: caseId },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as FirstShiftOnboardingCaseWithRelations | null;
        if (!onboardingCase || !ACTIVE_STATUSES.includes(onboardingCase.status as any)) return null;

        const updated = await firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            status: "FAILED",
            completedAt: new Date(),
            failureReason: reason || null,
        });
        await api.sendMessage(Number(updated.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.failed, { parse_mode: "HTML" });
        await this.postTopicStatus(api, updated, `${FIRST_SHIFT_ONBOARDING_TEXTS.topicFailed}${reason ? `\n\nПричина: ${escapeHtml(reason)}` : ""}`);
        await timelineRepository.createEvent(updated.candidate.userId, "SYSTEM_EVENT", "SYSTEM", "First shift onboarding failed", { caseId: updated.id, reason });
        return updated;
    }

    async handleTopicReply(api: Api, chatId: number, topicId: number, messageId: number, fromId?: number) {
        const onboardingCase = await firstShiftOnboardingRepository.findActiveCaseByTopicId(topicId, chatId);
        if (!onboardingCase) return false;
        if (fromId && Number(onboardingCase.candidate.user.telegramId) === fromId) return false;
        await api.copyMessage(Number(onboardingCase.candidate.user.telegramId), chatId, messageId);
        await timelineRepository.createEvent(onboardingCase.candidate.userId, "MESSAGE", "ADMIN", "[First shift onboarding forum reply]", {
            caseId: onboardingCase.id,
            topicId,
            adminId: fromId,
        });
        return true;
    }

    async autoOpenUpcomingCases(bot: Bot) {
        if (!FIRST_SHIFT_ONBOARDING_CHAT_ID) return;
        const now = new Date();
        const windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
        const candidates = await firstShiftOnboardingRepository.findUpcomingCandidatesForAutoOpen(now, windowEnd);
        for (const candidate of candidates) {
            const shiftStart = this.getShiftStartAt(candidate.firstShiftDate, candidate.firstShiftTime, candidate.location?.schedule);
            if (shiftStart && (shiftStart.getTime() < now.getTime() || shiftStart.getTime() > windowEnd.getTime())) {
                continue;
            }
            try {
                await this.notifyCandidate(bot.api, candidate.id);
            } catch (err) {
                logger.error({ err, candidateId: candidate.id }, "Failed to auto-open first shift onboarding case");
            }
        }
        await this.autoOpenClosingSteps(bot.api);
    }

    private async submitStep(api: Api, onboardingCase: FirstShiftOnboardingCaseWithRelations, step: FirstShiftOnboardingStep, submission: { text?: string }) {
        await firstShiftOnboardingRepository.updateStep(step.id, {
            status: step.requiresMentorApproval ? "SUBMITTED" : "APPROVED",
            submittedText: submission.text || step.submittedText || null,
            submittedAt: new Date(),
            completedAt: step.requiresMentorApproval ? null : new Date(),
        });

        await this.postTopicStatus(
            api,
            onboardingCase,
            `📤 <b>${escapeHtml(step.block)}: ${escapeHtml(step.title)}</b>\n${submission.text ? escapeHtml(submission.text) : "Кандидат підтвердила виконання."}`,
            step.requiresMentorApproval
                ? this.buildMentorStepKeyboard({ ...step, status: "SUBMITTED" } as FirstShiftOnboardingStep)
                : new InlineKeyboard()
        );

        if (step.requiresMentorApproval) {
            await api.sendMessage(Number(onboardingCase.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.submitted, { parse_mode: "HTML" });
            return onboardingCase;
        }

        await api.sendMessage(Number(onboardingCase.candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.submittedNoApproval, { parse_mode: "HTML" });
        return this.advanceFromResolvedStep(api, onboardingCase, step);
    }

    private async sendEntryMessage(api: Api, onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const candidate = onboardingCase.candidate;
        await api.sendMessage(Number(candidate.user.telegramId), FIRST_SHIFT_ONBOARDING_TEXTS.notifyCandidate(
            this.formatDate(candidate.firstShiftDate),
            candidate.firstShiftTime || "",
            candidate.location?.name || candidate.city || "",
        ), {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text(FIRST_SHIFT_ONBOARDING_TEXTS.startButton, `fso_start_${onboardingCase.id}`)
                .row()
                .text(FIRST_SHIFT_ONBOARDING_TEXTS.askMentorButton, `fso_ask_${onboardingCase.id}`),
        });
    }

    private async getCaseForCandidateCallback(caseId: string, telegramId: number) {
        const onboardingCase = await prisma.firstShiftOnboardingCase.findUnique({
            where: { id: caseId },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as FirstShiftOnboardingCaseWithRelations | null;

        if (!onboardingCase || Number(onboardingCase.candidate.user.telegramId) !== telegramId) return null;
        if (!ACTIVE_STATUSES.includes(onboardingCase.status as any)) return null;
        return onboardingCase;
    }

    private async findActiveCaseByStepId(stepId: string) {
        const step = await prisma.firstShiftOnboardingStep.findUnique({ where: { id: stepId } });
        if (!step) return null;
        return firstShiftOnboardingRepository.findActiveCaseByCandidateId(
            (await prisma.firstShiftOnboardingCase.findUnique({ where: { id: step.caseId } }))?.candidateId || ""
        );
    }

    private async autoOpenClosingSteps(api: Api) {
        const cases = await prisma.firstShiftOnboardingCase.findMany({
            where: {
                status: "IN_PROGRESS",
                currentStepKey: null,
            },
            include: {
                candidate: { include: { user: true, location: true, firstShiftPartner: { include: { user: true } } } },
                steps: { orderBy: { order: "asc" } },
            },
        }) as FirstShiftOnboardingCaseWithRelations[];

        for (const onboardingCase of cases) {
            const closingStep = onboardingCase.steps.find(step => step.block === CLOSING_BLOCK && step.status === "LOCKED");
            if (!closingStep || !this.canOpenClosingNow(onboardingCase)) continue;
            await this.openClosing(api, onboardingCase.id);
        }
    }

    private async sendCurrentStepToCandidate(api: Api, onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const step = this.getCurrentStep(onboardingCase);
        if (!step) return;
        const total = onboardingCase.steps.length;
        const text = `<b>Крок ${step.order}/${total}: ${escapeHtml(step.block)}</b>\n\n` +
            `<b>${escapeHtml(step.title)}</b>\n\n` +
            `${escapeHtml(step.prompt)}`;

        const keyboard = new InlineKeyboard();
        if (this.canCandidateSubmitByButton(step)) {
            keyboard.text("✅ Виконано", `fso_btn_${onboardingCase.id}`);
        } else if (step.inputType === FirstShiftOnboardingInputType.MULTIPLE_PHOTOS) {
            keyboard.text(FIRST_SHIFT_ONBOARDING_TEXTS.multiplePhotosDoneButton, `fso_done_${onboardingCase.id}`);
        }
        keyboard.row().text(FIRST_SHIFT_ONBOARDING_TEXTS.askMentorButton, `fso_ask_${onboardingCase.id}`);

        await api.sendMessage(Number(onboardingCase.candidate.user.telegramId), text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
        });
    }

    private async forwardCandidateMessageToTopic(
        api: Api,
        onboardingCase: FirstShiftOnboardingCaseWithRelations,
        message: FirstShiftOnboardingCandidateMessage,
        label: string,
        stepForKeyboard?: FirstShiftOnboardingStep | null
    ) {
        if (!onboardingCase.chatId || !onboardingCase.topicId) return;
        const targetChatId = Number(onboardingCase.chatId);
        const targetTopicId = onboardingCase.topicId;
        const sourceChatId = message.chatId;
        const sourceMessageId = message.messageId;
        const reviewKeyboard = this.buildMentorStepKeyboard(stepForKeyboard);
        const hasReviewButtons = Boolean(stepForKeyboard && this.canMentorResolveStep(stepForKeyboard));
        const shouldCopyOriginal = this.canCopyOriginalMessage(message);

        const reviewText = stepForKeyboard
            ? this.buildMentorReviewText(onboardingCase, stepForKeyboard, label, message.text, shouldCopyOriginal)
            : `<b>${escapeHtml(label)}</b>${message.text && !shouldCopyOriginal ? `\n\n${escapeHtml(message.text)}` : ""}`;

        if (!shouldCopyOriginal) {
            await api.sendMessage(targetChatId, reviewText, {
                parse_mode: "HTML",
                message_thread_id: targetTopicId,
                ...(hasReviewButtons ? { reply_markup: reviewKeyboard } : {}),
            });
            return;
        }

        await api.sendMessage(targetChatId, reviewText, {
            parse_mode: "HTML",
            message_thread_id: targetTopicId,
        });

        if (shouldCopyOriginal && sourceChatId !== undefined && sourceMessageId !== undefined) {
            await this.copyOriginalMessageToTopic(api, onboardingCase, message, undefined, hasReviewButtons ? reviewKeyboard : undefined).catch(async err => {
                logger.warn({ err }, "Failed to copy first-shift onboarding candidate message to topic");
                if (hasReviewButtons) {
                    await api.sendMessage(targetChatId, "⬆️ Review the submitted media above and choose an action.", {
                        parse_mode: "HTML",
                        message_thread_id: targetTopicId,
                        reply_markup: reviewKeyboard,
                    }).catch(fallbackErr => logger.warn({ err: fallbackErr }, "Failed to send first-shift onboarding review fallback"));
                }
            });
        }
    }

    private async copyOriginalMessageToTopic(
        api: Api,
        onboardingCase: FirstShiftOnboardingCaseWithRelations,
        message: FirstShiftOnboardingCandidateMessage,
        fallbackLabel?: string,
        replyMarkup?: InlineKeyboard,
    ) {
        if (!onboardingCase.chatId || !onboardingCase.topicId) return;
        if (!this.canCopyOriginalMessage(message)) {
            if (fallbackLabel) {
                await api.sendMessage(Number(onboardingCase.chatId), `<b>${escapeHtml(fallbackLabel)}</b>`, {
                    parse_mode: "HTML",
                    message_thread_id: onboardingCase.topicId,
                    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                });
            }
            return;
        }

        await api.copyMessage(Number(onboardingCase.chatId), message.chatId!, message.messageId!, {
            message_thread_id: onboardingCase.topicId,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        } as any);
    }

    private canCopyOriginalMessage(message: FirstShiftOnboardingCandidateMessage) {
        return Boolean(message.hasCopyableOriginal && message.chatId !== undefined && message.messageId !== undefined);
    }

    private async postTopicStatus(api: Api, onboardingCase: FirstShiftOnboardingCaseWithRelations, text: string, replyMarkup?: InlineKeyboard) {
        if (!onboardingCase.chatId || !onboardingCase.topicId) return;
        await this.syncStatusCard(api, onboardingCase);
        const extra = {
            parse_mode: "HTML" as const,
            message_thread_id: onboardingCase.topicId,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        };
        await api.sendMessage(Number(onboardingCase.chatId), text, extra);
    }

    private buildTopicCard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const candidate = onboardingCase.candidate;
        return `${FIRST_SHIFT_ONBOARDING_TEXTS.topicOpened}\n\n` +
            `👤 <b>Фотограф:</b> ${escapeHtml(candidate.fullName || candidate.user.firstName || "Candidate")}\n` +
            `🔗 <b>Telegram:</b> ${candidate.user.username ? `@${escapeHtml(candidate.user.username)}` : "—"}\n` +
            `📍 <b>Локація:</b> ${escapeHtml(candidate.location?.name || candidate.city || "—")}\n` +
            `🗓 <b>Зміна:</b> ${escapeHtml(this.formatDate(candidate.firstShiftDate))} ${escapeHtml(candidate.firstShiftTime || "")}`;
    }

    private buildStatusCard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const currentStep = this.getCurrentStep(onboardingCase);
        const total = onboardingCase.steps.length;
        const stepLine = currentStep
            ? `${currentStep.order}/${total}`
            : `—/${total}`;
        const mentorState = this.getMentorStateLabel(onboardingCase, currentStep);
        const mentorAction = this.getMentorActionCompact(onboardingCase, currentStep);
        const waitingLabel = this.getWaitingCompactLabel(onboardingCase, currentStep);
        const photographerTask = currentStep
            ? escapeHtml(currentStep.prompt)
            : escapeHtml(this.getNoStepTaskText(onboardingCase));
        const currentLabel = currentStep
            ? `${stepLine} · ${escapeHtml(currentStep.title)}`
            : stepLine;

        return `${this.buildTopicCard(onboardingCase)}\n\n` +
            `━━━━━━━━━━━━━━\n` +
            `📌 <b>Стан:</b> ${mentorState}\n` +
            `🔢 <b>Зараз:</b> ${currentLabel}\n` +
            `📝 <b>Що робить фотограф:</b> ${photographerTask}\n` +
            `👩‍🏫 <b>Дія ментора:</b> ${escapeHtml(mentorAction)}\n` +
            `⏱ <b>Очікує:</b> ${escapeHtml(waitingLabel)}\n` +
            `🕒 <b>Оновлено:</b> ${escapeHtml(this.formatDateTime(new Date()))}`;
    }

    private buildMentorCaseKeyboard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const keyboard = new InlineKeyboard();
        const step = this.getCurrentStep(onboardingCase);
        if (step && this.canMentorResolveStep(step)) {
            keyboard.text("✅ Підтвердити", `fso_ap_${step.id}`)
                .text("🔁 На переробку", `fso_rj_${step.id}`)
                .row();
        }

        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            keyboard.text("🔓 Відкрити закриття", `fso_close_${onboardingCase.id}`).row();
        }

        return keyboard;
    }

    private buildMentorStepKeyboard(step?: FirstShiftOnboardingStep | null) {
        const keyboard = new InlineKeyboard();
        if (!step || !this.canMentorResolveStep(step)) return keyboard;
        keyboard.text("✅ Підтвердити", `fso_ap_${step.id}`)
            .text("🔁 На переробку", `fso_rj_${step.id}`);
        return keyboard;
    }

    buildRejectReasonKeyboard(stepId: string) {
        return new InlineKeyboard()
            .text("📷 Не видно / ракурс", `fso_rjc_${stepId}_bad_photo`)
            .row()
            .text("🧩 Не все надіслано", `fso_rjc_${stepId}_incomplete`)
            .row()
            .text("✍️ Напишу причину", `fso_rjc_${stepId}_custom`)
            .text("Без коментаря", `fso_rjc_${stepId}_none`);
    }

    private buildFinalKeyboard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        return new InlineKeyboard()
            .text("✅ Завершити успішно", `fso_pass_${onboardingCase.id}`)
            .row()
            .text("❌ Не пройшла", `fso_fail_${onboardingCase.id}`);
    }

    private buildFinalReviewText(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const total = onboardingCase.steps.length;
        return `${FIRST_SHIFT_ONBOARDING_TEXTS.topicAllStepsApproved}\n\n` +
            `<b>Прогрес:</b> ${total}/${total} кроків підтверджено\n` +
            `<b>Дія ментора:</b> перевірити підсумок першої зміни і натиснути фінальне рішення нижче.`;
    }

    private getCurrentStep(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        return onboardingCase.steps.find(step => step.status === "ACTIVE" || step.status === "SUBMITTED" || step.key === onboardingCase.currentStepKey && !["APPROVED", "SKIPPED"].includes(step.status))
            || onboardingCase.steps.find(step => step.status === "REJECTED");
    }

    private buildMentorReviewText(
        onboardingCase: FirstShiftOnboardingCaseWithRelations,
        step: FirstShiftOnboardingStep,
        label: string,
        messageText?: string,
        mediaCopied = false,
    ) {
        const total = onboardingCase.steps.length;
        const submittedText = messageText && !mediaCopied ? `\n\n<b>Відповідь:</b> ${escapeHtml(messageText)}` : "";
        const materialLine = mediaCopied
            ? "\n<b>Матеріал:</b> фото/скрін нижче"
            : "";

        return `<b>${escapeHtml(label)}</b>\n` +
            `<b>Крок:</b> ${step.order}/${total} · ${escapeHtml(step.block)} · ${escapeHtml(step.title)}\n` +
            `<b>Очікується:</b> ${escapeHtml(step.prompt)}${materialLine}${submittedText}\n` +
            `<b>Дія ментора:</b> перевірити і натиснути Підтвердити або На переробку.`;
    }

    private getNextStep(onboardingCase: FirstShiftOnboardingCaseWithRelations, currentOrder: number) {
        return onboardingCase.steps.find(step => step.order > currentOrder && !["APPROVED", "SKIPPED"].includes(step.status));
    }

    private isPhotoInput(inputType: FirstShiftOnboardingInputType) {
        return inputType === FirstShiftOnboardingInputType.PHOTO ||
            inputType === FirstShiftOnboardingInputType.SCREENSHOT ||
            inputType === FirstShiftOnboardingInputType.MULTIPLE_PHOTOS;
    }

    private isTextInput(inputType: FirstShiftOnboardingInputType) {
        return inputType === FirstShiftOnboardingInputType.TEXT ||
            inputType === FirstShiftOnboardingInputType.LINK;
    }

    private canCandidateSubmitByButton(step: FirstShiftOnboardingStep) {
        return step.inputType === FirstShiftOnboardingInputType.BUTTON ||
            step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED;
    }

    private canMentorResolveStep(step?: FirstShiftOnboardingStep | null) {
        if (!step) return false;
        if (step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            return step.status === "ACTIVE" || step.status === "SUBMITTED";
        }
        return step.status === "SUBMITTED";
    }

    private statusIcon(status: string) {
        switch (status) {
            case "APPROVED": return "✅";
            case "SUBMITTED": return "⏳";
            case "ACTIVE": return "▶️";
            case "REJECTED": return "🔁";
            case "SKIPPED": return "⏭";
            default: return "🔒";
        }
    }

    private formatDate(date?: Date | null) {
        if (!date) return "—";
        return new Date(date).toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Kyiv" });
    }

    private formatDateTime(date?: Date | null) {
        if (!date) return "—";
        return new Date(date).toLocaleString("uk-UA", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Europe/Kyiv",
        });
    }

    private getMentorStateLabel(onboardingCase: FirstShiftOnboardingCaseWithRelations, step?: FirstShiftOnboardingStep | null) {
        if (onboardingCase.status === "OPEN") return "⏳ Очікує старту фотографа";
        if (onboardingCase.status === "PENDING_FINAL") return "✅ Очікує фінального рішення";
        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            return "⏳ Очікує відкриття блоку закриття";
        }
        if (step?.status === "SUBMITTED" || step?.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            return "👀 Очікує ментора";
        }
        return "▶️ Фотограф виконує крок";
    }

    private getMentorActionText(onboardingCase: FirstShiftOnboardingCaseWithRelations, step?: FirstShiftOnboardingStep | null) {
        if (onboardingCase.status === "OPEN") {
            return "Дочекатися натискання кнопки старту фотографом і тримати topic під рукою для швидкої відповіді.";
        }
        if (onboardingCase.status === "PENDING_FINAL") {
            return "Перевірити, що зміна завершена коректно, і прийняти фінальне рішення нижче.";
        }
        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            return "Коли до кінця зміни лишиться 30 хвилин або раніше за потреби, відкрити блок закриття.";
        }
        if (!step) {
            return "Слідкувати за topic і відповісти фотографу, якщо надійде питання.";
        }
        if (step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            return "Підключитися віддалено, перевірити виконання вживу та натиснути потрібне рішення.";
        }
        if (step.status === "SUBMITTED") {
            if (this.isPhotoInput(step.inputType)) {
                return "Переглянути фото або скрін вище й підтвердити крок або повернути його на переробку.";
            }
            if (this.isTextInput(step.inputType)) {
                return "Перевірити текст або посилання вище й підтвердити крок або повернути його на переробку.";
            }
            return "Перевірити результат кроку й підтвердити його або повернути на переробку.";
        }
        return "Дочекатися матеріалів або питання від фотографа. Кнопки рішення з'являться, коли крок буде готовий до перевірки.";
    }

    private getNoStepTaskText(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        if (onboardingCase.status === "OPEN") {
            return "Онбординг ще не стартував. Після натискання кнопки старту тут з'явиться перший активний крок.";
        }
        if (onboardingCase.status === "PENDING_FINAL") {
            return "Усі кроки пройдено, фотограф очікує фінального рішення.";
        }
        if (onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            return "Фотограф завершила блок відкриття та працює у звичайному режимі до старту закриття зміни.";
        }
        return "Очікування наступної дії у флоу.";
    }

    private getMentorActionCompact(onboardingCase: FirstShiftOnboardingCaseWithRelations, step?: FirstShiftOnboardingStep | null) {
        if (onboardingCase.status === "PENDING_FINAL") {
            return "Перевірити завершення зміни і прийняти фінальне рішення.";
        }
        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            return "Відкрити блок закриття, коли це доречно.";
        }
        if (!step) {
            return "Слідкувати за повідомленнями фотографа у topic.";
        }
        if (step.status === "SUBMITTED" || step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            return "Перевірити виконання і натиснути Підтвердити або На переробку.";
        }
        return "Очікувати матеріали від фотографа.";
    }

    private getWaitingCompactLabel(onboardingCase: FirstShiftOnboardingCaseWithRelations, step?: FirstShiftOnboardingStep | null) {
        const now = new Date();
        if (onboardingCase.status === "PENDING_FINAL") {
            const waitingSince = this.getLatestResolvedAt(onboardingCase) || onboardingCase.updatedAt || onboardingCase.createdAt;
            return this.formatRelativeDuration(waitingSince, now);
        }
        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            const waitingSince = this.getLatestResolvedAt(onboardingCase) || onboardingCase.updatedAt || onboardingCase.createdAt;
            return this.formatRelativeDuration(waitingSince, now);
        }
        if (step && (step.status === "SUBMITTED" || step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED)) {
            const waitingSince = step.submittedAt || step.updatedAt || onboardingCase.updatedAt || onboardingCase.createdAt;
            return this.formatRelativeDuration(waitingSince, now);
        }
        if (step) {
            const inProgressSince = step.updatedAt || onboardingCase.updatedAt || onboardingCase.createdAt;
            return this.formatRelativeDuration(inProgressSince, now);
        }
        return this.formatRelativeDuration(onboardingCase.updatedAt || onboardingCase.createdAt, now);
    }

    private getProgressLabel(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const approved = onboardingCase.steps.filter(step => step.status === "APPROVED").length;
        const total = onboardingCase.steps.length;
        const currentStep = this.getCurrentStep(onboardingCase);
        if (!currentStep) {
            return `${approved}/${total} завершено`;
        }

        const blockSteps = onboardingCase.steps.filter(step => step.block === currentStep.block);
        const approvedInBlock = blockSteps.filter(step => step.status === "APPROVED").length;
        return `${approved}/${total} завершено · ${currentStep.block}: ${approvedInBlock}/${blockSteps.length}`;
    }

    private getTimingLabel(onboardingCase: FirstShiftOnboardingCaseWithRelations, step?: FirstShiftOnboardingStep | null) {
        const now = new Date();
        if (onboardingCase.status === "OPEN") {
            return `очікує старту ${this.formatRelativeDuration(onboardingCase.createdAt, now)}`;
        }
        if (onboardingCase.status === "PENDING_FINAL") {
            const waitingSince = this.getLatestResolvedAt(onboardingCase) || onboardingCase.updatedAt || onboardingCase.createdAt;
            return `чекає фінального рішення ${this.formatRelativeDuration(waitingSince, now)}`;
        }
        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            const waitingSince = this.getLatestResolvedAt(onboardingCase) || onboardingCase.updatedAt || onboardingCase.createdAt;
            return `очікує відкриття closing ${this.formatRelativeDuration(waitingSince, now)}`;
        }
        if (!step) {
            return `активний кейс ${this.formatRelativeDuration(onboardingCase.updatedAt || onboardingCase.createdAt, now)}`;
        }
        if (step.status === "SUBMITTED" || step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            const waitingSince = step.submittedAt || step.updatedAt || onboardingCase.updatedAt || onboardingCase.createdAt;
            return `чекає ментора ${this.formatRelativeDuration(waitingSince, now)}`;
        }
        const inProgressSince = step.updatedAt || onboardingCase.updatedAt || onboardingCase.createdAt;
        return `у роботі ${this.formatRelativeDuration(inProgressSince, now)}`;
    }

    private getLastActionLabel(onboardingCase: FirstShiftOnboardingCaseWithRelations, step?: FirstShiftOnboardingStep | null) {
        if (onboardingCase.status === "OPEN") {
            return `Кейс відкрито ${this.formatDateTime(onboardingCase.createdAt)}`;
        }
        if (onboardingCase.status === "PENDING_FINAL") {
            const latestApproved = this.getLatestResolvedStep(onboardingCase);
            if (latestApproved?.approvedAt || latestApproved?.completedAt) {
                const resolvedAt = latestApproved.approvedAt || latestApproved.completedAt;
                return `Ментор підтвердила «${latestApproved.title}» о ${this.formatDateTime(resolvedAt)}`;
            }
            return "Усі кроки завершені, кейс очікує фінального рішення";
        }
        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            const latestApproved = this.getLatestResolvedStep(onboardingCase);
            if (latestApproved?.approvedAt || latestApproved?.completedAt) {
                const resolvedAt = latestApproved.approvedAt || latestApproved.completedAt;
                return `Завершено блок відкриття на кроці «${latestApproved.title}» о ${this.formatDateTime(resolvedAt)}`;
            }
            return "Фотограф завершила відкриття і працює до блоку закриття";
        }
        if (!step) {
            return `Останнє оновлення кейса о ${this.formatDateTime(onboardingCase.updatedAt || onboardingCase.createdAt)}`;
        }
        if (step.status === "SUBMITTED" && step.submittedAt) {
            return `Фотограф надіслала результат по кроку «${step.title}» о ${this.formatDateTime(step.submittedAt)}`;
        }
        if (step.inputType === FirstShiftOnboardingInputType.MENTOR_OBSERVED) {
            return `Фотограф дійшла до live-перевірки «${step.title}» о ${this.formatDateTime(step.updatedAt || onboardingCase.updatedAt || onboardingCase.createdAt)}`;
        }
        if (step.mentorComment) {
            return `Ментор залишила коментар до кроку «${step.title}»: ${step.mentorComment}`;
        }
        return `Крок «${step.title}» активний з ${this.formatDateTime(step.updatedAt || onboardingCase.updatedAt || onboardingCase.createdAt)}`;
    }

    private getLatestResolvedAt(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const timestamps = onboardingCase.steps
            .flatMap(step => [step.approvedAt, step.completedAt])
            .filter((value): value is Date => value instanceof Date);

        if (!timestamps.length) return null;
        return timestamps.sort((a, b) => b.getTime() - a.getTime())[0] || null;
    }

    private getLatestResolvedStep(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const resolved = onboardingCase.steps
            .filter(step => step.approvedAt || step.completedAt)
            .sort((a, b) => {
                const aTime = (a.approvedAt || a.completedAt || a.updatedAt).getTime();
                const bTime = (b.approvedAt || b.completedAt || b.updatedAt).getTime();
                return bTime - aTime;
            });

        return resolved[0] || null;
    }

    private formatRelativeDuration(from?: Date | null, to = new Date()) {
        if (!from) return "щойно";
        const diffMs = Math.max(0, to.getTime() - from.getTime());
        const totalMinutes = Math.floor(diffMs / 60000);
        if (totalMinutes < 1) return "менше хвилини";
        if (totalMinutes < 60) return `${totalMinutes} хв`;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (hours < 24) {
            return minutes > 0 ? `${hours} год ${minutes} хв` : `${hours} год`;
        }
        const days = Math.floor(hours / 24);
        const remHours = hours % 24;
        return remHours > 0 ? `${days} д ${remHours} год` : `${days} д`;
    }

    private async syncStatusCard(api: Api, onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        if (!onboardingCase.chatId || !onboardingCase.topicId) return onboardingCase;

        const text = this.buildStatusCard(onboardingCase);
        const replyMarkup = onboardingCase.status === "PENDING_FINAL"
            ? this.buildFinalKeyboard(onboardingCase)
            : this.buildMentorCaseKeyboard(onboardingCase);

        if (onboardingCase.statusMessageId) {
            try {
                await api.editMessageText(Number(onboardingCase.chatId), onboardingCase.statusMessageId, text, {
                    parse_mode: "HTML",
                    reply_markup: replyMarkup,
                });
                return onboardingCase;
            } catch (err) {
                logger.warn({ err, caseId: onboardingCase.id, statusMessageId: onboardingCase.statusMessageId }, "Failed to update first-shift onboarding status card, sending a new one");
            }
        }

        const sent = await api.sendMessage(Number(onboardingCase.chatId), text, {
            parse_mode: "HTML",
            message_thread_id: onboardingCase.topicId,
            reply_markup: replyMarkup,
        });

        if (typeof (api as any).pinChatMessage === "function" && typeof sent.message_id === "number") {
            await (api as any).pinChatMessage(Number(onboardingCase.chatId), sent.message_id, {
                disable_notification: true,
            }).catch((err: unknown) => logger.warn({ err, caseId: onboardingCase.id, messageId: sent.message_id }, "Failed to pin first-shift onboarding status card"));
        }

        return firstShiftOnboardingRepository.updateCase(onboardingCase.id, {
            statusMessageId: sent.message_id,
        });
    }

    private canOpenClosingNow(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const shiftEnd = this.getShiftEndAt(onboardingCase);
        if (!shiftEnd) return false;
        return new Date().getTime() >= shiftEnd.getTime() - CLOSING_OPEN_LEAD_MS;
    }

    private getShiftEndAt(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const date = onboardingCase.candidate.firstShiftDate;
        if (!date) return null;
        const time = onboardingCase.candidate.firstShiftTime
            || getShiftTimeFromLocationSchedule(onboardingCase.candidate.location?.schedule, date);
        if (!time) return null;

        const matches = Array.from(time.matchAll(/(\d{1,2})[:.](\d{2})/g));
        const last = matches[matches.length - 1];
        if (!last) return null;

        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Europe/Kyiv",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(date);

        const year = Number(parts.find((part) => part.type === "year")?.value);
        const month = Number(parts.find((part) => part.type === "month")?.value);
        const day = Number(parts.find((part) => part.type === "day")?.value);

        return createKyivDate(year, month - 1, day, Number(last[1] || 0), Number(last[2] || 0));
    }

    private getShiftStartAt(date?: Date | null, explicitTime?: string | null, schedule?: string | null) {
        if (!date) return null;
        const time = explicitTime || getShiftTimeFromLocationSchedule(schedule, date);
        const match = time?.match(/(\d{1,2})[:.](\d{2})?/);
        if (!match) return null;

        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: "Europe/Kyiv",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(date);

        const year = Number(parts.find((part) => part.type === "year")?.value);
        const month = Number(parts.find((part) => part.type === "month")?.value);
        const day = Number(parts.find((part) => part.type === "day")?.value);

        return createKyivDate(year, month - 1, day, Number(match[1] || 0), Number(match[2] || 0));
    }
}

export const firstShiftOnboardingService = new FirstShiftOnboardingService();

export function startFirstShiftOnboardingLoop(bot: Bot) {
    if (!FIRST_SHIFT_ONBOARDING_CHAT_ID) {
        logger.warn("FIRST_SHIFT_ONBOARDING_CHAT_ID is not configured; first-shift onboarding auto-open loop is disabled");
        return;
    }

    const run = () => {
        firstShiftOnboardingService.autoOpenUpcomingCases(bot).catch(err => {
            logger.error({ err }, "First shift onboarding auto-open loop failed");
        });
    };

    setTimeout(run, 30_000);
    setInterval(run, 5 * 60 * 1000);
}
