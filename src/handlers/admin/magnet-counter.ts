import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import logger from "../../core/logger.js";
import { magnetCountService } from "../../services/magnet-count-service.js";
import { logBusinessEvent } from "../../core/log-events.js";
import prisma from "../../db/core.js";
import { OPENAI_VISION_MODEL } from "../../config.js";

const ALLOWED_ROLES = new Set(["SUPPORT"]);

export const adminMagnetCounterHandlers = new Composer<MyContext>();

function getMagnetCounterKeyboard(hasResult = false) {
    const kb = new InlineKeyboard();
    if (hasResult) {
        kb.text("✅ Confirm", "admin_magnet_counter_confirm")
            .text("✏️ Correct", "admin_magnet_counter_correct").row();
    }

    kb.text("🧲 New Photo", "admin_magnet_counter_start").row()
        .text("⬅️ Back", "admin_system_back");

    return kb;
}

function formatConfidence(confidence: "high" | "medium" | "low") {
    return confidence;
}

function buildResultText(result: {
    total?: number | undefined;
    confidence?: "high" | "medium" | "low" | undefined;
    stackCounts?: number[] | undefined;
    notes?: string | undefined;
    correctedTotal?: number | undefined;
    requiresManualConfirmation?: boolean | undefined;
}) {
    const lines = ["🧲 <b>Magnet Count</b>", ""];

    const stackCounts = result.stackCounts || [];
    if (stackCounts.length > 0) {
        stackCounts.forEach((count, index) => {
            lines.push(`Stack ${index + 1}: <b>${count}</b>`);
        });
        lines.push("");
    }

    if (typeof result.total === "number") {
        lines.push(`Total: <b>${result.total}</b>`);
    }

    if (result.confidence) {
        lines.push(`Confidence: <b>${formatConfidence(result.confidence)}</b>`);
    }

    if (result.requiresManualConfirmation) {
        lines.push(`Status: <b>Manual confirmation required</b>`);
    }

    if (result.notes) {
        lines.push(`Model note: <i>${result.notes}</i>`);
    }

    if (typeof result.correctedTotal === "number") {
        lines.push(`Manual correction: <b>${result.correctedTotal}</b>`);
    }

    return lines.join("\n");
}

function buildConfirmationText(result: {
    total?: number | undefined;
    correctedTotal?: number | undefined;
}) {
    const finalTotal = typeof result.correctedTotal === "number" ? result.correctedTotal : result.total;
    return [
        "✅ <b>Magnet count saved</b>",
        "",
        typeof finalTotal === "number"
            ? `Final total: <b>${finalTotal}</b>`
            : "The result has been saved.",
        "",
        "You can continue from the System menu."
    ].join("\n");
}

async function ensureRole(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const role = await getUserAdminRole(BigInt(telegramId));
    return role ? ALLOWED_ROLES.has(role) : false;
}

async function getAdminUserId(ctx: MyContext) {
    const telegramId = ctx.from?.id;
    if (!telegramId) return null;

    const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        select: { id: true }
    });

    return user?.id ?? null;
}

adminMagnetCounterHandlers.callbackQuery("admin_magnet_counter_start", async (ctx) => {
    if (!await ensureRole(ctx)) {
        await ctx.answerCallbackQuery({ text: "Access denied", show_alert: true });
        return;
    }

    ctx.session.step = "support_magnet_count_photo";
    delete ctx.session.supportData?.magnetCount;

    await ctx.answerCallbackQuery();
    await ScreenManager.renderScreen(
        ctx,
        "🧲 <b>Count Magnets</b>\n\nSend one photo of the magnet stacks. I will return stack-by-stack counts, the total count, and the confidence level.",
        getMagnetCounterKeyboard(false),
        { pushToStack: true }
    );
});

adminMagnetCounterHandlers.callbackQuery("admin_magnet_counter_confirm", async (ctx) => {
    const result = ctx.session.supportData?.magnetCount;
    if (!result || typeof result.estimateTotal !== "number") {
        await ctx.answerCallbackQuery("No active result.");
        return;
    }

    if (result.recordId) {
        await prisma.magnetCountRun.update({
            where: { id: result.recordId },
            data: {
                finalTotal: result.correctedTotal ?? result.estimateTotal,
                finalizedAt: new Date(),
                isManuallyCorrected: typeof result.correctedTotal === "number" && result.correctedTotal !== result.estimateTotal,
            }
        }).catch(() => { });
    }

    ctx.session.step = "idle";
    delete ctx.session.supportData?.magnetCount;
    await ctx.answerCallbackQuery("Count confirmed.");
    await ScreenManager.renderScreen(
        ctx,
        buildConfirmationText({
            total: result.estimateTotal,
            correctedTotal: result.correctedTotal,
        }),
        "admin-system",
        { forceNew: true }
    );
});

adminMagnetCounterHandlers.callbackQuery("admin_magnet_counter_correct", async (ctx) => {
    const result = ctx.session.supportData?.magnetCount;
    if (!result || typeof result.estimateTotal !== "number") {
        await ctx.answerCallbackQuery("Upload a photo first.");
        return;
    }

    ctx.session.step = "support_magnet_count_correct_total";
    await ctx.answerCallbackQuery();
    await ScreenManager.renderScreen(
        ctx,
        `✏️ <b>Correct Count</b>\n\nModel estimate: <b>${result.estimateTotal}</b>\nSend the correct total as a single number.`,
        new InlineKeyboard().text("⬅️ Back", "admin_magnet_counter_start"),
        { pushToStack: true }
    );
});

export async function handleAdminMagnetCounterMessage(ctx: MyContext): Promise<boolean> {
    if (!await ensureRole(ctx)) {
        return false;
    }

    if (ctx.chat?.type !== "private") {
        return false;
    }

    if (ctx.session.step === "support_magnet_count_correct_total") {
        const raw = ctx.message?.text?.trim();
        if (!raw || !/^\d+$/.test(raw)) {
            await ctx.reply("Send numbers only, for example `53`.", { parse_mode: "Markdown" });
            return true;
        }

        const correctedTotal = Number(raw);
        if (!ctx.session.supportData) ctx.session.supportData = {};
        if (!ctx.session.supportData.magnetCount) ctx.session.supportData.magnetCount = {};
        ctx.session.supportData.magnetCount.correctedTotal = correctedTotal;
        ctx.session.step = "idle";

        if (ctx.session.supportData.magnetCount.recordId) {
            await prisma.magnetCountRun.update({
                where: { id: ctx.session.supportData.magnetCount.recordId },
                data: {
                    finalTotal: correctedTotal,
                    isManuallyCorrected: true,
                    finalizedAt: new Date(),
                }
            }).catch((err) => {
                logger.warn({ err, telegramId: ctx.from?.id }, "Failed to persist corrected magnet count");
            });
        }

        logBusinessEvent({
            event: "support.magnet_count.corrected",
            actorType: "admin",
            actorRole: "support",
            telegramId: ctx.from?.id,
            result: "success",
            module: "admin-magnet-counter",
            operation: "handleAdminMagnetCounterMessage",
            updateId: ctx.update.update_id,
            safeContext: {
                estimatedTotal: ctx.session.supportData.magnetCount.estimateTotal ?? null,
                correctedTotal,
                confidence: ctx.session.supportData.magnetCount.confidence ?? null,
            }
        });

        await ScreenManager.renderScreen(
            ctx,
            buildResultText({
                total: ctx.session.supportData.magnetCount.estimateTotal,
                confidence: ctx.session.supportData.magnetCount.confidence,
                stackCounts: ctx.session.supportData.magnetCount.stackCounts,
                notes: ctx.session.supportData.magnetCount.notes,
                correctedTotal,
                requiresManualConfirmation: ctx.session.supportData.magnetCount.confidence === "low",
            }),
            getMagnetCounterKeyboard(true),
            { forceNew: true }
        );

        return true;
    }

    if (ctx.session.step !== "support_magnet_count_photo") {
        return false;
    }

    if (!ctx.message?.photo?.length) {
        await ctx.reply("A photo is required for counting. Send one photo of the magnet stacks.");
        return true;
    }

    if (!magnetCountService.isConfigured()) {
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(
            ctx,
            "⚠️ <b>Magnet counting is unavailable</b>\n\n`OPENAI_API_KEY` is not configured on the server yet, so vision analysis is currently disabled.",
            getMagnetCounterKeyboard(false),
            { forceNew: true }
        );
        return true;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) {
        await ctx.reply("I could not read that photo. Please send it again.");
        return true;
    }

    await ctx.reply("🔍 Analyzing the photo. This may take a few seconds...");

    try {
        const result = await magnetCountService.countFromTelegramPhoto(photo.file_id);
        const adminUserId = await getAdminUserId(ctx);

        let recordId: string | undefined;
        if (adminUserId) {
            const created = await prisma.magnetCountRun.create({
                data: {
                    adminUserId,
                    photoFileId: photo.file_id,
                    estimatedTotal: result.total,
                    confidence: result.confidence,
                    stackCounts: JSON.stringify(result.stacks.map((stack) => ({
                        index: stack.index,
                        estimatedCount: stack.estimatedCount,
                        confidence: stack.confidence,
                    }))),
                    notes: result.notes || null,
                    model: OPENAI_VISION_MODEL || null,
                },
                select: { id: true }
            });
            recordId = created.id;
        }

        if (!ctx.session.supportData) ctx.session.supportData = {};
        ctx.session.supportData.magnetCount = {
            ...(recordId ? { recordId } : {}),
            estimateTotal: result.total,
            confidence: result.confidence,
            stackCounts: result.stacks.map((stack) => stack.estimatedCount),
            notes: result.notes,
            analyzedPhotoFileId: photo.file_id,
        };
        ctx.session.step = "idle";

        logBusinessEvent({
            event: "support.magnet_count.completed",
            actorType: "admin",
            actorRole: "support",
            telegramId: ctx.from?.id,
            result: "success",
            module: "admin-magnet-counter",
            operation: "handleAdminMagnetCounterMessage",
            updateId: ctx.update.update_id,
            safeContext: {
                total: result.total,
                confidence: result.confidence,
                stackCount: result.stacks.length,
                needsManualReview: result.needsManualReview,
            }
        });

        await ScreenManager.renderScreen(
            ctx,
            buildResultText({
                total: result.total,
                confidence: result.confidence,
                stackCounts: result.stacks.map((stack) => stack.estimatedCount),
                notes: result.notes,
                requiresManualConfirmation: result.confidence === "low" || result.needsManualReview,
            }) + ((result.confidence === "low" || result.needsManualReview)
                ? "\n\n⚠️ <b>Low confidence.</b> Please verify the result manually before using it."
                : ""),
            getMagnetCounterKeyboard(true),
            { forceNew: true }
        );

        return true;
    } catch (error) {
        logger.error({ err: error, telegramId: ctx.from?.id }, "Magnet counter analysis failed");
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(
            ctx,
            "❌ <b>Could not count the magnets</b>\n\nTry another photo with less glare, and make sure the top and bottom of each stack are visible.",
            getMagnetCounterKeyboard(false),
            { forceNew: true }
        );
        return true;
    }
}
