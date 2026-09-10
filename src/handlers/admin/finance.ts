import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { MONO_FOP_IBANS } from "../../config.js";
import { hasFinanceAccess } from "./permissions.js";
import { dashboardService } from "../../services/finance/dashboard-service.js";
import { redis } from "../../core/redis.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { InputFile, InlineKeyboard, Composer } from "grammy";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { staffService } from "../../modules/staff/services/index.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import logger from "../../core/logger.js";

// --- 3. FINANCE MENU ---
export const adminFinanceMenu = new Menu<MyContext>("admin-finance");
adminFinanceMenu.dynamic(async (ctx, range) => {
    const telegramId = ctx.from?.id;
    let userRole = null;
    if (telegramId) {
        userRole = await getUserAdminRole(BigInt(telegramId));
    }

    const isSuperAdmin = userRole === 'SUPER_ADMIN';
    const isCoFounder = userRole === 'CO_FOUNDER';

    // Hide everything else from SUPPORT
    if (userRole === 'SUPPORT') {
        range.text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
            const { staffService } = await import("../../modules/staff/services/index.js");
            const text = await staffService.getAdminHeader(userRole as any);
            await ScreenManager.goBack(ctx, text, "admin-main");
        }).row();
        return;
    }

    if (isSuperAdmin) {
        range.text(ADMIN_TEXTS["admin-finance-balances"], (ctx) => handleDailyStatus(ctx));
    }

    // Reports & Sync button (visible to Super Admin and Co-founder)
    if (isSuperAdmin || isCoFounder) {
        range.text(ADMIN_TEXTS["admin-finance-report"], async (ctx) => {
            if (!(await hasFinanceAccess(ctx))) {
                await ctx.reply("🔒 Access denied.");
                return;
            }
            await ctx.answerCallbackQuery().catch(() => { });
            const statusMsg = await ctx.reply(ADMIN_TEXTS["admin-finance-report-loading"], { parse_mode: "HTML" });
            try {
                const { sendDailyIncomeReport } = await import("../../services/finance-report.js");
                const { bot } = await import("../../core/bot.js");
                await sendDailyIncomeReport(bot as any, ctx.chat!.id, true);
            } finally {
                await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
            }
        });
    }

    // ONLY SUPER_ADMIN sees technical re-sync options (DDS, Audit, Statements)
    if (isSuperAdmin) {
        range.row().text(ADMIN_TEXTS["admin-finance-statement"], async (ctx) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-finance-statement"], "admin-statement-fop", { pushToStack: true });
        });
    }

    range.row().text(ADMIN_TEXTS["admin-btn-back"], async (ctx) => {
        const { staffService } = await import("../../modules/staff/services/index.js");
        const userRole = await getUserAdminRole(BigInt(ctx.from!.id));
        const text = await staffService.getAdminHeader(userRole as any);
        await ScreenManager.goBack(ctx, text, "admin-main");
    });
});

// --- CALLBACK HANDLERS ---
export const financeHandlers = new Composer<MyContext>();

financeHandlers.callbackQuery("admin_finance_back", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => { });
    const telegramId = ctx.from?.id;
    let userRole = null;
    if (telegramId) {
        userRole = await getUserAdminRole(BigInt(telegramId));
    }

    const text = "💰 <b>Finance Management</b>";
    const options = {
        parse_mode: "HTML" as const,
        reply_markup: adminFinanceMenu
    };

    try {
        // If current message is a document, editing to text will fail
        await ctx.editMessageText(text, options);
    } catch (e) {
        // Fallback: Delete and send new
        await ctx.deleteMessage().catch(() => { });
        await ctx.reply(text, options);
    }
});

// Екрани «Audit Actions» (розбір розбіжностей звірки) прибрані 10.09.2026
// разом з усім модулем реконсиляції: без неї цих дій нікому створювати.

async function handleDailyStatus(ctx: MyContext) {
    if (!(await hasFinanceAccess(ctx))) return;

    await ctx.answerCallbackQuery().catch(() => { });

    const redisKeyLastReport = `finance:last_status_msg:${ctx.chat!.id}`;
    const redisKeyLoading = `finance:loading_msg:${ctx.chat!.id}`;

    try {
        // 1. Clean up ANY previous messages
        const [lastReportId, lastLoadingId] = await Promise.all([
            redis.get(redisKeyLastReport),
            redis.get(redisKeyLoading)
        ]);

        if (lastReportId) await ctx.api.deleteMessage(ctx.chat!.id, parseInt(lastReportId)).catch(() => { });
        if (lastLoadingId) await ctx.api.deleteMessage(ctx.chat!.id, parseInt(lastLoadingId)).catch(() => { });

        // 2. Send NEW loading message
        const statusMsg = await ctx.reply(ADMIN_TEXTS["admin-finance-collecting"]);
        await redis.set(redisKeyLoading, statusMsg.message_id.toString(), 'EX', 300);

        const waitStatuses: Record<string, string> = { general: ADMIN_TEXTS["admin-finance-collecting"] };
        let lastUpdate = 0;

        const onWait = async (msg: string) => {
            const fopMatch = msg.match(/\[(.*?)\]/);
            const key = (fopMatch && fopMatch[1]) ? fopMatch[1] : 'general';
            waitStatuses[key] = msg;

            const now = Date.now();
            if (now - lastUpdate > 2000) {
                lastUpdate = now;
                const combined = Object.values(waitStatuses).filter(Boolean).join('\n\n');
                await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, combined).catch(() => { });
            }
        };

        const status = await dashboardService.getDailyStatus(onWait);
        const reportText = dashboardService.formatStatusReport(status);

        // 3. Delete loading message and send final report (text)
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => { });
        await redis.del(redisKeyLoading);

        const sentMsg = await ctx.reply(reportText, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
                .text(ADMIN_TEXTS["admin-btn-refresh"], "admin_finance_balances_refresh")
                .row()
                .text(ADMIN_TEXTS["admin-btn-back"], "admin_finance_back")
        });
        await redis.set(redisKeyLastReport, sentMsg.message_id.toString());

    } catch (e: any) {
        logger.error({ err: e }, "Finance daily status rendering failed");
        const currentLoadingId = await redis.get(redisKeyLoading);
        if (currentLoadingId) {
            await ctx.api.editMessageText(ctx.chat!.id, parseInt(currentLoadingId), `❌ Error: ${e.message}`).catch(() => { });
            await redis.del(redisKeyLoading);
        } else {
            await ctx.reply(`❌ Error: ${e.message}`);
        }
    }
}

// --- 6. STATEMENT FOP SELECTION ---
export const adminStatementFopMenu = new Menu<MyContext>("admin-statement-fop")
    .text("👤 Kuznetsov", (ctx) => generateStatement(ctx, "kuznetsov"))
    .text("👤 Posrednikova", (ctx) => generateStatement(ctx, "posrednikova"))
    .row()
    .text("👤 Karpuk", (ctx) => generateStatement(ctx, "karpuk"))
    .text("👤 Gupalova", (ctx) => generateStatement(ctx, "gupalova"))
    .row()
    .text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "💰 <b>Finance & Audit</b>", "admin-finance");
    });

async function generateStatement(ctx: MyContext, fopKey: string) {
    if (!(await hasFinanceAccess(ctx))) return;

    await ctx.answerCallbackQuery().catch(() => { });
    const statusMsg = await ctx.reply(ADMIN_TEXTS["admin-finance-gen-statement"]({ fopKey }));

    try {
        const { monoClients } = await import("../../services/finance/monobank.js");

        const client = (monoClients as any)[fopKey];
        if (!client) {
            await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ Client not found.");
            return;
        }

        const now = new Date();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(now.getDate() - 7);

        const startTs = Math.floor(new Date(sevenDaysAgo.setHours(0, 0, 0, 0)).getTime() / 1000);
        const endTs = Math.floor(now.getTime() / 1000);

        const onWait = async (msg: string) => {
            await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, msg).catch(() => { });
        };

        const fopIbans = MONO_FOP_IBANS[fopKey.toUpperCase()] || [];
        const accountIds = await client.getAccountIdsByIbans(fopIbans);

        if (accountIds.length === 0) {
            await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ FOP account not found.");
            return;
        }

        // Use the first matching UAH FOP account
        const targetAccountId = accountIds[0];

        const html = await client.generateHtmlStatement(targetAccountId, startTs, endTs, fopKey.charAt(0).toUpperCase() + fopKey.slice(1), onWait);

        if (html) {
            const { InputFile } = await import("grammy");
            const buffer = Buffer.from(html, 'utf-8');

            await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => { });
            await ctx.replyWithDocument(new InputFile(buffer, `statement_${fopKey}_last_7_days_${new Date().toISOString().split('T')[0]}.html`), {
                reply_markup: new InlineKeyboard().text(ADMIN_TEXTS["admin-btn-home"], "admin_finance_back")
            });
        } else {
            await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, "❌ No transactions found.");
        }
    } catch (error: any) {
        logger.error({ err: error, fopKey }, "Finance statement generation failed");
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Error: ${error.message}`);
    }
}

// Меню ручної звірки, runAuditForDate і синхронізація ДДС прибрані 10.09.2026
// (рішення власника). Лишилися Monobank-баланси і виписки ФОП — вони до ДДС
// стосунку не мають.

