import { Composer } from "grammy";
import type { MyContext } from "../types/context.js";
import { FIRST_SHIFT_ONBOARDING_CHAT_ID } from "../config.js";
import { getAdminRoleByTelegramId } from "../config/roles.js";
import { firstShiftOnboardingService, type FirstShiftOnboardingCandidateMessage } from "../services/first-shift-onboarding-service.js";
import { getRichMessagePlainText } from "../utils/rich-message.js";

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
    const result = await firstShiftOnboardingService.approveStep(ctx.api, stepId, ctx.from?.id);
    await ctx.answerCallbackQuery(result?.status === "PENDING_FINAL"
        ? "All steps approved. Choose the final decision below."
        : result ? "Step approved. Next action is in the topic." : "Step is no longer awaiting approval.");
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_rj_(.+)$/, async (ctx) => {
    const stepId = ctx.match[1];
    if (!stepId) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }
    ctx.session.step = `fso_reject_reason_${stepId}`;
    await ctx.answerCallbackQuery("Choose or write the redo reason.");
    await ctx.reply("🔁 <b>Що саме потрібно переробити?</b>\n\nОбери швидку причину або напиши свою відповідь у цей topic.", {
        parse_mode: "HTML",
        reply_markup: firstShiftOnboardingService.buildRejectReasonKeyboard(stepId),
    });
});

firstShiftOnboardingHandlers.callbackQuery(/^fso_rjc_(.+)_(bad_photo|incomplete|custom|none)$/, async (ctx) => {
    const stepId = ctx.match[1];
    const reasonCode = ctx.match[2];
    if (!stepId || !reasonCode) return;
    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) {
        await ctx.answerCallbackQuery("Unavailable.");
        return;
    }

    if (reasonCode === "custom") {
        ctx.session.step = `fso_reject_reason_${stepId}`;
        await ctx.answerCallbackQuery("Write the reason in this topic.");
        return;
    }

    const reason = reasonCode === "bad_photo"
        ? "Не видно потрібні деталі або невдалий ракурс. Надішли, будь ласка, чіткіше фото."
        : reasonCode === "incomplete"
            ? "Надіслано не всі потрібні матеріали. Додай, будь ласка, повний комплект."
            : null;

    ctx.session.step = "idle";
    const result = await firstShiftOnboardingService.rejectStep(ctx.api, stepId, reason);
    await ctx.answerCallbackQuery(result ? "Step returned for redo." : "Step is no longer awaiting review.");
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

    return firstShiftOnboardingService.handleCandidateMessage(ctx.api, ctx.from.id, buildFirstShiftOnboardingPayload(ctx));
}

export function buildFirstShiftOnboardingPayload(ctx: MyContext): FirstShiftOnboardingCandidateMessage {
    const richText = getRichMessagePlainText(ctx.message?.rich_message) || undefined;
    const text = ctx.message?.text || ctx.message?.caption || richText;
    const photoId = ctx.message?.photo?.[ctx.message.photo.length - 1]?.file_id || null;
    const hasMedia = Boolean(
        photoId ||
        ctx.message?.voice ||
        ctx.message?.video_note ||
        ctx.message?.video ||
        ctx.message?.document ||
        ctx.message?.audio ||
        ctx.message?.animation ||
        ctx.message?.sticker ||
        ctx.message?.rich_message,
    );
    const hasFormattedText = Boolean(ctx.message?.entities?.length || ctx.message?.caption_entities?.length);

    const payload: FirstShiftOnboardingCandidateMessage = {
        photoId,
        hasCopyableOriginal: hasMedia || hasFormattedText,
    };
    if (ctx.message?.message_id !== undefined) payload.messageId = ctx.message.message_id;
    if (ctx.chat?.id !== undefined) payload.chatId = ctx.chat.id;
    if (text !== undefined) payload.text = text;
    return payload;
}

export async function handleFirstShiftOnboardingGroupMessage(ctx: MyContext): Promise<boolean> {
    if (!FIRST_SHIFT_ONBOARDING_CHAT_ID) return false;
    if (!ctx.chat || Number(ctx.chat.id) !== FIRST_SHIFT_ONBOARDING_CHAT_ID) return false;
    if (!ctx.message?.message_thread_id || !ctx.message.message_id) return false;
    if (ctx.from?.id === ctx.me.id) return false;

    const role = ctx.from?.id ? getAdminRoleByTelegramId(BigInt(ctx.from.id)) : null;
    if (!role) return false;

    if (ctx.session.step?.startsWith("fso_reject_reason_")) {
        const stepId = ctx.session.step.replace("fso_reject_reason_", "");
        const reason = ctx.message.text || ctx.message.caption;
        if (!reason) {
            await ctx.reply("Напиши причину текстом або обери швидку причину з кнопок вище.", { parse_mode: "HTML" });
            return true;
        }

        ctx.session.step = "idle";
        await firstShiftOnboardingService.rejectStep(ctx.api, stepId, reason);
        return true;
    }

    return firstShiftOnboardingService.handleTopicReply(
        ctx.api,
        Number(ctx.chat.id),
        ctx.message.message_thread_id,
        ctx.message.message_id,
        ctx.from?.id,
    );
}
