import type { Api, Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type { FirstShiftOnboardingStep } from "@prisma/client";
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

        return firstShiftOnboardingRepository.createCase(candidateId, steps);
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

        await api.sendMessage(FIRST_SHIFT_ONBOARDING_CHAT_ID, this.buildTopicCard(updated), {
            parse_mode: "HTML",
            message_thread_id: topic.message_thread_id,
            reply_markup: this.buildMentorCaseKeyboard(updated),
        });

        return updated;
    }

    async notifyCandidate(api: Api, candidateId: string) {
        const onboardingCase = await this.openCaseForCandidate(api, candidateId);
        await this.sendEntryMessage(api, onboardingCase);

        logBusinessEvent({
            event: "first_shift_onboarding.candidate_notified",
            actorType: "system",
            result: "success",
            module: "first-shift-onboarding",
            candidateId,
            safeContext: { caseId: onboardingCase.id, topicId: onboardingCase.topicId },
        });

        return onboardingCase;
    }

    async resumeCandidateFlowFromStart(api: Api, telegramId: number) {
        const candidate = await candidateRepository.findByTelegramId(telegramId);
        if (!candidate) return false;

        const onboardingCase = await firstShiftOnboardingRepository.findActiveCaseByCandidateId(candidate.id);
        if (!onboardingCase) return false;

        if (onboardingCase.status === "OPEN") {
            await this.sendEntryMessage(api, onboardingCase);
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
        if (!step || step.inputType !== FirstShiftOnboardingInputType.BUTTON) return null;
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

    async handleCandidateMessage(api: Api, telegramId: number, message: {
        text?: string;
        photoId?: string | null;
        messageId?: number;
        chatId?: number;
    }) {
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
            await this.forwardCandidateMessageToTopic(api, onboardingCase, message, "💬 Повідомлення від фотографа");
            await api.sendMessage(telegramId, FIRST_SHIFT_ONBOARDING_TEXTS.mentorObservedCandidate, { parse_mode: "HTML" });
            return true;
        }

        if (this.isPhotoInput(step.inputType)) {
            if (!message.photoId) {
                if (message.text) {
                    await this.forwardCandidateMessageToTopic(api, onboardingCase, message, "💬 Питання від фотографа");
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

            await this.forwardCandidateMessageToTopic(
                api,
                onboardingCase,
                message,
                `📤 ${step.block}: ${step.title}`,
                {
                    ...step,
                    status: step.inputType === FirstShiftOnboardingInputType.MULTIPLE_PHOTOS ? "ACTIVE" : "SUBMITTED",
                } as FirstShiftOnboardingStep
            );

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
            await this.postTopicStatus(api, pending, FIRST_SHIFT_ONBOARDING_TEXTS.topicAllStepsApproved, this.buildFinalKeyboard(pending));
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
        await this.postTopicStatus(api, updated, `🔁 Step returned for redo: ${escapeHtml(step.title)}.`);
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
        if (step.inputType === FirstShiftOnboardingInputType.BUTTON) {
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
        message: { text?: string; photoId?: string | null; messageId?: number; chatId?: number },
        label: string,
        stepForKeyboard?: FirstShiftOnboardingStep | null
    ) {
        if (!onboardingCase.chatId || !onboardingCase.topicId) return;
        const sourceChatId = message.chatId;
        const sourceMessageId = message.messageId;
        const shouldCopyOriginal = Boolean(
            message.photoId &&
            sourceChatId !== undefined &&
            sourceMessageId !== undefined
        );
        await api.sendMessage(Number(onboardingCase.chatId), `<b>${escapeHtml(label)}</b>${message.text && !shouldCopyOriginal ? `\n\n${escapeHtml(message.text)}` : ""}`, {
            parse_mode: "HTML",
            message_thread_id: onboardingCase.topicId,
            reply_markup: this.buildMentorStepKeyboard(stepForKeyboard || this.getCurrentStep(onboardingCase)),
        });
        if (shouldCopyOriginal && sourceChatId !== undefined && sourceMessageId !== undefined) {
            await api.copyMessage(Number(onboardingCase.chatId), sourceChatId, sourceMessageId, {
                message_thread_id: onboardingCase.topicId,
            } as any).catch(err => logger.warn({ err }, "Failed to copy first-shift onboarding candidate message to topic"));
        }
    }

    private async postTopicStatus(api: Api, onboardingCase: FirstShiftOnboardingCaseWithRelations, text: string, replyMarkup?: InlineKeyboard) {
        if (!onboardingCase.chatId || !onboardingCase.topicId) return;
        await api.sendMessage(Number(onboardingCase.chatId), text, {
            parse_mode: "HTML",
            message_thread_id: onboardingCase.topicId,
            reply_markup: replyMarkup || this.buildMentorCaseKeyboard(onboardingCase),
        });
    }

    private buildTopicCard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const candidate = onboardingCase.candidate;
        return `${FIRST_SHIFT_ONBOARDING_TEXTS.topicOpened}\n\n` +
            `👤 <b>Фотограф:</b> ${escapeHtml(candidate.fullName || candidate.user.firstName || "Candidate")}\n` +
            `🔗 <b>Telegram:</b> ${candidate.user.username ? `@${escapeHtml(candidate.user.username)}` : "—"}\n` +
            `📍 <b>Локація:</b> ${escapeHtml(candidate.location?.name || candidate.city || "—")}\n` +
            `🗓 <b>Зміна:</b> ${escapeHtml(this.formatDate(candidate.firstShiftDate))} ${escapeHtml(candidate.firstShiftTime || "")}`;
    }

    private buildMentorCaseKeyboard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const keyboard = new InlineKeyboard();
        const step = this.getCurrentStep(onboardingCase);
        if (step && this.canMentorResolveStep(step)) {
            keyboard.text("✅ Approve", `fso_ap_${step.id}`)
                .text("🔁 Redo", `fso_rj_${step.id}`)
                .row();
        }

        if (!step && onboardingCase.steps.some(item => item.block === CLOSING_BLOCK && item.status === "LOCKED")) {
            keyboard.text("🔒 Open Closing", `fso_close_${onboardingCase.id}`).row();
        }

        return keyboard;
    }

    private buildMentorStepKeyboard(step?: FirstShiftOnboardingStep | null) {
        const keyboard = new InlineKeyboard();
        if (!step || !this.canMentorResolveStep(step)) return keyboard;
        keyboard.text("✅ Approve", `fso_ap_${step.id}`)
            .text("🔁 Redo", `fso_rj_${step.id}`);
        return keyboard;
    }

    private buildFinalKeyboard(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        return new InlineKeyboard()
            .text("✅ Complete Successfully", `fso_pass_${onboardingCase.id}`)
            .row()
            .text("❌ Mark as Failed", `fso_fail_${onboardingCase.id}`);
    }

    private getCurrentStep(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        return onboardingCase.steps.find(step => step.status === "ACTIVE" || step.status === "SUBMITTED" || step.key === onboardingCase.currentStepKey && !["APPROVED", "SKIPPED"].includes(step.status))
            || onboardingCase.steps.find(step => step.status === "REJECTED");
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

    private canOpenClosingNow(onboardingCase: FirstShiftOnboardingCaseWithRelations) {
        const shiftEnd = this.getShiftEndAt(onboardingCase);
        if (!shiftEnd) return false;
        return new Date().getTime() >= shiftEnd.getTime() - 60 * 60 * 1000;
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
