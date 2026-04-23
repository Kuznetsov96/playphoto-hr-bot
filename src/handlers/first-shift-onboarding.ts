import { Composer } from "grammy";
import type { MyContext } from "../types/context.js";
import { FIRST_SHIFT_ONBOARDING_CHAT_ID } from "../config.js";
import { getAdminRoleByTelegramId } from "../config/roles.js";
import { firstShiftOnboardingService } from "../services/first-shift-onboarding-service.js";

export const firstShiftOnboardingHandlers = new Composer<MyContext>();

firstShiftOnboardingHandlers.callbackQuery(/^fso_start_(.+)$/, async (ctx) => {
    const caseId = ctx.match[1];
    if (!caseId) return;
    await ctx.answerCallbackQuery();
    await firstShiftOnboardingService.startCandidateFlow(ctx.api, caseId, ctx.from!.id);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_ask_(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Напиши питання в чат, ментор побачить його в онбординг-топіку.");
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_btn_(.+)$/, async (ctx) => {
    const caseId = ctx.match[1];
    if (!caseId) return;
    await ctx.answerCallbackQuery();
    await firstShiftOnboardingService.submitButtonStep(ctx.api, caseId, ctx.from!.id);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_done_(.+)$/, async (ctx) => {
    const caseId = ctx.match[1];
    if (!caseId) return;
    await ctx.answerCallbackQuery();
    await firstShiftOnboardingService.finishMultiplePhotos(ctx.api, caseId, ctx.from!.id);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_ap_(.+)$/, async (ctx) => {
    const stepId = ctx.match[1];
    if (!stepId) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }
    await ctx.answerCallbackQuery("Step approved.");
    await firstShiftOnboardingService.approveStep(ctx.api, stepId, ctx.from?.id);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_rj_(.+)$/, async (ctx) => {
    const stepId = ctx.match[1];
    if (!stepId) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }
    await ctx.answerCallbackQuery("Step returned for redo.");
    await firstShiftOnboardingService.rejectStep(ctx.api, stepId);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_close_(.+)$/, async (ctx) => {
    const caseId = ctx.match[1];
    if (!caseId) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }
    await ctx.answerCallbackQuery("Closing checklist opened.");
    await firstShiftOnboardingService.openClosing(ctx.api, caseId);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_pass_(.+)$/, async (ctx) => {
    const caseId = ctx.match[1];
    if (!caseId) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }
    await ctx.answerCallbackQuery("Onboarding completed successfully.");
    await firstShiftOnboardingService.completeCase(ctx.api, caseId);
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_fail_(.+)$/, async (ctx) => {
    const caseId = ctx.match[1];
    if (!caseId) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }
    await ctx.answerCallbackQuery("Onboarding marked as failed.");
    await firstShiftOnboardingService.failCase(ctx.api, caseId);
});

export async function handleFirstShiftOnboardingCandidateMessage(ctx: MyContext): Promise<boolean> {
    if (!ctx.from?.id || ctx.chat?.type !== "private" || !ctx.message) return false;

    const text = ctx.message.text || ctx.message.caption || undefined;
    const photoId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id || null;

    const payload: { text?: string; photoId?: string | null; messageId?: number; chatId?: number } = {
        photoId,
        messageId: ctx.message.message_id,
        chatId: ctx.chat.id,
    };
    if (text !== undefined) payload.text = text;

    return firstShiftOnboardingService.handleCandidateMessage(ctx.api, ctx.from.id, payload);
}

export async function handleFirstShiftOnboardingGroupMessage(ctx: MyContext): Promise<boolean> {
    if (!FIRST_SHIFT_ONBOARDING_CHAT_ID) return false;
    if (!ctx.chat || Number(ctx.chat.id) !== FIRST_SHIFT_ONBOARDING_CHAT_ID) return false;
    if (!ctx.message?.message_thread_id || !ctx.message.message_id) return false;
    if (ctx.from?.id === ctx.me.id) return false;

    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) return false;

    return firstShiftOnboardingService.handleTopicReply(
        ctx.api,
        Number(ctx.chat.id),
        ctx.message.message_thread_id,
        ctx.message.message_id,
        ctx.from?.id,
    );
}
