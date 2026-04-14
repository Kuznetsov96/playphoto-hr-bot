import { Composer, InlineKeyboard } from "grammy";
import type { MyContext } from "../../types/context.js";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import logger from "../../core/logger.js";
import { magnetCountService } from "../../services/magnet-count-service.js";
import { logBusinessEvent } from "../../core/log-events.js";
import prisma from "../../db/core.js";
import { OPENAI_VISION_MODEL } from "../../config.js";

const ALLOWED_ROLES = new Set(["SUPPORT", "SUPER_ADMIN", "CO_FOUNDER"]);

export const adminMagnetCounterHandlers = new Composer<MyContext>();

function getMagnetCounterKeyboard(hasResult = false) {
    const kb = new InlineKeyboard();
    if (hasResult) {
        kb.text("✅ Підтвердити", "admin_magnet_counter_confirm")
            .text("✏️ Виправити", "admin_magnet_counter_correct").row();
    }

    kb.text("🧲 Нове фото", "admin_magnet_counter_start").row()
        .text("⬅️ Back", "admin_system_back");

    return kb;
}

function formatConfidence(confidence: "high" | "medium" | "low") {
    if (confidence === "high") return "висока";
    if (confidence === "medium") return "середня";
    return "низька";
}

function buildResultText(result: {
    total?: number | undefined;
    confidence?: "high" | "medium" | "low" | undefined;
    stackCounts?: number[] | undefined;
    notes?: string | undefined;
    correctedTotal?: number | undefined;
}) {
    const lines = ["🧲 <b>Підрахунок магнітів</b>", ""];

    const stackCounts = result.stackCounts || [];
    if (stackCounts.length > 0) {
        stackCounts.forEach((count, index) => {
            lines.push(`Стопка ${index + 1}: <b>${count}</b>`);
        });
        lines.push("");
    }

    if (typeof result.total === "number") {
        lines.push(`Разом: <b>${result.total}</b>`);
    }

    if (result.confidence) {
        lines.push(`Впевненість: <b>${formatConfidence(result.confidence)}</b>`);
    }

    if (result.notes) {
        lines.push(`Коментар моделі: <i>${result.notes}</i>`);
    }

    if (typeof result.correctedTotal === "number") {
        lines.push(`Ручне коригування: <b>${result.correctedTotal}</b>`);
    }

    return lines.join("\n");
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
        await ctx.answerCallbackQuery({ text: "Недостатньо прав", show_alert: true });
        return;
    }

    ctx.session.step = "support_magnet_count_photo";
    delete ctx.session.supportData?.magnetCount;

    await ctx.answerCallbackQuery();
    await ScreenManager.renderScreen(
        ctx,
        "🧲 <b>Порахувати магніти</b>\n\nНадішли одне фото стопок магнітів. Я поверну підрахунок по стопках, загальну кількість і рівень впевненості.",
        getMagnetCounterKeyboard(false),
        { pushToStack: true }
    );
});

adminMagnetCounterHandlers.callbackQuery("admin_magnet_counter_confirm", async (ctx) => {
    const result = ctx.session.supportData?.magnetCount;
    if (!result || typeof result.estimateTotal !== "number") {
        await ctx.answerCallbackQuery("Немає активного результату.");
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
    await ctx.answerCallbackQuery("Підрахунок підтверджено.");
    await ScreenManager.renderScreen(
        ctx,
        buildResultText({
            total: result.estimateTotal,
            confidence: result.confidence,
            stackCounts: result.stackCounts,
            notes: result.notes,
            correctedTotal: result.correctedTotal,
        }),
        getMagnetCounterKeyboard(true),
        { forceNew: true }
    );
});

adminMagnetCounterHandlers.callbackQuery("admin_magnet_counter_correct", async (ctx) => {
    const result = ctx.session.supportData?.magnetCount;
    if (!result || typeof result.estimateTotal !== "number") {
        await ctx.answerCallbackQuery("Спочатку завантаж фото.");
        return;
    }

    ctx.session.step = "support_magnet_count_correct_total";
    await ctx.answerCallbackQuery();
    await ScreenManager.renderScreen(
        ctx,
        `✏️ <b>Виправлення підрахунку</b>\n\nМодель оцінила: <b>${result.estimateTotal}</b>\nНадішли правильну загальну кількість одним числом.`,
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
            await ctx.reply("Надішли тільки число, наприклад `53`.", { parse_mode: "Markdown" });
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
        await ctx.reply("Для підрахунку потрібне фото. Надішли одне фото стопок магнітів.");
        return true;
    }

    if (!magnetCountService.isConfigured()) {
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(
            ctx,
            "⚠️ <b>Підрахунок магнітів недоступний</b>\n\nНа сервері ще не налаштований `OPENAI_API_KEY`, тому vision-аналіз зараз вимкнений.",
            getMagnetCounterKeyboard(false),
            { forceNew: true }
        );
        return true;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) {
        await ctx.reply("Не вдалося прочитати фото. Спробуй надіслати його ще раз.");
        return true;
    }

    await ctx.reply("🔍 Аналізую фото, це може зайняти кілька секунд...");

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
            }) + (result.needsManualReview ? "\n\n⚠️ Рекомендую перевірити результат вручну." : ""),
            getMagnetCounterKeyboard(true),
            { forceNew: true }
        );

        return true;
    } catch (error) {
        logger.error({ err: error, telegramId: ctx.from?.id }, "Magnet counter analysis failed");
        ctx.session.step = "idle";
        await ScreenManager.renderScreen(
            ctx,
            "❌ <b>Не вдалося порахувати магніти</b>\n\nСпробуй інше фото: без сильних відблисків, щоб було видно весь верх і низ стопок.",
            getMagnetCounterKeyboard(false),
            { forceNew: true }
        );
        return true;
    }
}
