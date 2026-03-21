import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { MONO_FOP_IBANS } from "../../config.js";
import { hasFinanceAccess } from "./permissions.js";
import { monobankService } from "../../services/finance/monobank.js";
import { dashboardService } from "../../services/finance/dashboard-service.js";
import { redis } from "../../core/redis.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { InputFile, InlineKeyboard, Composer } from "grammy";
import { getUserAdminRole } from "../../middleware/role-check.js";
import { startExpenseFlow } from "./finance-expense.js";
import { staffService } from "../../modules/staff/services/index.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { techCashService } from "../../services/finance/tech-cash.js";
import logger from "../../core/logger.js";

// --- 3. FINANCE MENU ---
export const adminFinanceMenu = new Menu<MyContext>("admin-finance");
adminFinanceMenu.dynamic(async (ctx, range) => {
    const telegramId = ctx.from?.id;
    let userRole = null;
    if (telegramId) {
        userRole = await getUserAdminRole(BigInt(telegramId));
        logger.info(`[FINANCE MENU] User ${telegramId} role resolved to: ${userRole}`);
    }

    const isSuperAdmin = userRole === 'SUPER_ADMIN';
    const isCoFounder = userRole === 'CO_FOUNDER';

    // PRIMARY ACTION: Add Expense (Super Admin, Co-founder, Support)
    if (isSuperAdmin || isCoFounder || userRole === 'SUPPORT') {
        range.text("💸 Add Expense", async (ctx) => {
            await ctx.deleteMessage();
            await startExpenseFlow(ctx);
        }).row();
    }

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
            const { sendDailyIncomeReport } = await import("../../services/finance-report.js");
            const { bot } = await import("../../core/bot.js");
            await sendDailyIncomeReport(bot as any, ctx.chat!.id, true);
        });
    }

    // ONLY SUPER_ADMIN sees technical re-sync options (DDS, Audit, Statements)
    if (isSuperAdmin) {
        range.row().text(ADMIN_TEXTS["admin-finance-sync-dds"], async (ctx) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-finance-sync-dds"], "admin-dds-sync", { pushToStack: true });
        });
        range.row().text(ADMIN_TEXTS["admin-finance-audit"], async (ctx) => {
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["admin-finance-audit"], "admin-audit", { pushToStack: true });
        });
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

financeHandlers.callbackQuery(/^admin_audit_actions:(.+)$/, async (ctx) => {
    const dateStr = ctx.match![1]!;
    const raw = await redis.get(`audit:actions:${dateStr}`);
    const actions = raw ? JSON.parse(raw) : null;

    if (!actions?.length) return ctx.answerCallbackQuery("No pending actions. ✨");

    await ctx.answerCallbackQuery();

    let text = `⚙️ <b>AUDIT ACTION CENTER • ${dateStr}</b>\n\n`;
    const keyboard = new InlineKeyboard();
    actions.forEach((action: any, idx: number) => {
        const askedIcon = action.asked ? ' 💬' : '';
        const locName = action.location;
        keyboard.text(`${idx + 1}. 📍 ${locName}${askedIcon}`, `audit_action_detail:${idx}:${dateStr}`).row();
    });

    try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    } catch (e) {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    }
});

financeHandlers.callbackQuery(/^audit_action_detail:(\d+):(.+)$/, async (ctx) => {
    const idx = parseInt(ctx.match![1]!);
    const dateStr = ctx.match![2]!;
    const raw = await redis.get(`audit:actions:${dateStr}`);
    const actions = raw ? JSON.parse(raw) : null;
    const action = actions?.[idx];

    if (!action) return ctx.answerCallbackQuery("❌ Action expired.");

    await ctx.answerCallbackQuery();

    const typeIcon = action.type === 'Terminal' ? '💳' : '💵';
    const diffStr = action.diff.toLocaleString('uk-UA');
    const staffStr = action.staffNames?.length ? `\n👤 Staff: <b>${action.staffNames.join(', ')}</b>` : '';

    let text = `⚙️ <b>ACTION DETAILS</b>\n\n`;
    text += `📍 <b>${action.location}</b>\n`;
    text += `${typeIcon} Mismatch: <b>${diffStr} UAH</b>${staffStr}\n\n`;

    if (action.asked) {
        const askedAt = action.askedAt ? new Date(action.askedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }) : '';
        text += `💬 <i>Already asked at ${askedAt}</i>\n\n`;
    }

    const keyboard = new InlineKeyboard();
    const askLabel = action.asked ? `❓ Re-ask Staff` : `❓ Ask Staff`;
    keyboard.text(askLabel, `audit_ask_select:${idx}:${dateStr}`);
    keyboard.text(`✅ Resolve`, `audit_resolve:${idx}:${dateStr}`).row();
    keyboard.text(`⬅️ Back`, `admin_audit_actions:${dateStr}`);

    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
});

financeHandlers.callbackQuery(/^audit_ask_select:(\d+):(.+)$/, async (ctx) => {
    const idx = parseInt(ctx.match![1]!);
    const dateStr = ctx.match![2]!;
    const raw = await redis.get(`audit:actions:${dateStr}`);
    const actions = raw ? JSON.parse(raw) : null;
    const action = actions?.[idx];

    if (!action) return ctx.answerCallbackQuery("❌ Action expired.");

    if (action.staffIds.length === 1) {
        // Direct send — inline the send logic instead of broken .execute()
        return await sendAuditAsk(ctx, idx, dateStr, action.staffIds[0], action);
    }

    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard();
    action.staffIds.forEach((sid: string, sIdx: number) => {
        const name = action.staffNames?.[sIdx] || "Staff";
        keyboard.text(name, `audit_ask_send:${idx}:${dateStr}:${sid}`);
    });
    keyboard.text("👥 All", `audit_ask_send:${idx}:${dateStr}:all`).row();
    keyboard.text("⬅️ Back", `audit_action_detail:${idx}:${dateStr}`);

    await ctx.editMessageText(`Whom to ask about 📍 <b>${action.location}</b>?`, {
        parse_mode: "HTML",
        reply_markup: keyboard
    });
});

async function sendAuditAsk(ctx: MyContext, idx: number, dateStr: string, targetStaffId: string, action: any) {
    const { staffIds, staffNames, location, type, diff } = action;
    const typeIcon = type === 'Terminal' ? '💳' : '💵';
    const message = ADMIN_TEXTS["admin-audit-ask-msg"]({
        location,
        date: dateStr,
        type: `${typeIcon} ${type}`,
        diff: Math.abs(diff).toLocaleString('uk-UA')
    });

    const sendIds = targetStaffId === 'all' ? staffIds : [targetStaffId];
    let success = 0;

    for (const sid of sendIds) {
        try {
            await ctx.api.sendMessage(Number(sid), message, { parse_mode: "HTML" });
            success++;
        } catch (e) { logger.error({ err: e, sid }, "Ask fail"); }
    }

    if (success > 0) {
        const targetName = targetStaffId === 'all' ? 'Everyone' : (staffNames?.[staffIds.indexOf(targetStaffId)] || 'Staff');
        await ctx.answerCallbackQuery(`✅ Sent to ${targetName}`);

        // Mark as asked in Redis
        const currentActionsRaw = await redis.get(`audit:actions:${dateStr}`);
        const currentActions = currentActionsRaw ? JSON.parse(currentActionsRaw) : [];
        if (currentActions[idx]) {
            currentActions[idx].asked = true;
            currentActions[idx].askedAt = Date.now();
            await redis.set(`audit:actions:${dateStr}`, JSON.stringify(currentActions), 'EX', 86400);
        }

        await ctx.reply(ADMIN_TEXTS["admin-audit-ask-success"]({
            names: targetName,
            location,
            date: dateStr
        }), {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⬅️ Back to Action", `audit_action_detail:${idx}:${dateStr}`)
        });
    } else {
        await ctx.answerCallbackQuery("❌ Send failed.");
    }
}

financeHandlers.callbackQuery(/^audit_ask_send:(\d+):([^:]+):(.+)$/, async (ctx) => {
    const idx = parseInt(ctx.match![1]!);
    const dateStr = ctx.match![2]!;
    const targetStaffId = ctx.match![3]!;

    const raw = await redis.get(`audit:actions:${dateStr}`);
    const actions = raw ? JSON.parse(raw) : null;
    const action = actions?.[idx];
    if (!action) return ctx.answerCallbackQuery("❌ Action expired.");

    await sendAuditAsk(ctx, idx, dateStr, targetStaffId, action);
});

financeHandlers.callbackQuery(/^audit_resolve:(\d+):(.+)$/, async (ctx) => {
    const idx = parseInt(ctx.match![1]!);
    const dateStr = ctx.match![2]!;
    const raw = await redis.get(`audit:actions:${dateStr}`);
    const actions = raw ? JSON.parse(raw) : null;
    const action = actions?.[idx];
    if (!action) return ctx.answerCallbackQuery("❌ Action expired.");

    // Remove resolved action and update Redis
    actions.splice(idx, 1);
    if (actions.length > 0) {
        await redis.set(`audit:actions:${dateStr}`, JSON.stringify(actions), 'EX', 86400);
    } else {
        await redis.del(`audit:actions:${dateStr}`);
    }

    await ctx.answerCallbackQuery("✅ Resolved.");
    const keyboard = actions.length > 0 
        ? new InlineKeyboard().text("⬅️ Back to Action Center", `admin_audit_actions:${dateStr}`)
        : undefined;

    await ctx.editMessageText(`✅ <b>Resolved:</b> ${action.location} (${action.type})`, { 
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {})
    });
});

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
        logger.error({ err: e }, "❌ Daily Status Error:");
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
        logger.error({ err: error, fopKey }, "❌ Statement Error:");
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Error: ${error.message}`);
    }
}

// --- 5. AUDIT MENU (Date Selection) ---
export const adminAuditMenu = new Menu<MyContext>("admin-audit")
    .text("📅 Today", async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => { });
        await runAuditForDate(ctx, new Date());
    })
    .text("📅 Yesterday", async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => { });
        const d = new Date();
        d.setDate(d.getDate() - 1);
        await runAuditForDate(ctx, d);
    })
    .row()
    .text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "💰 <b>Finance & Audit</b>", "admin-finance");
    });

async function runAuditForDate(ctx: MyContext, date: Date) {
    if (!(await hasFinanceAccess(ctx))) return;

    const dateStr = date.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    const statusMsg = await ctx.reply(ADMIN_TEXTS["admin-finance-audit-running"]({ date: dateStr }));
    let incomes: any[] | undefined;

    // Warm Monobank caches in parallel with DDS catch-up to avoid cold-start waits in manual audits.
    const preWarmPromise = monobankService.preWarmForAudit(date).catch(e =>
        logger.warn({ err: e }, "❄️ Manual audit pre-warm failed, continuing with on-demand fetch")
    );

    // 1. "Catch-up" Sync: Ensure DDS is up to date before auditing
    try {
        const { syncToDDS } = await import("../../services/finance-report.js");
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `🔄 Catching up DDS for ${dateStr}...`).catch(() => { });
        incomes = await techCashService.getIncomeForDate(dateStr);
        await syncToDDS(dateStr, incomes).catch(e => logger.error({ err: e }, "❌ Catch-up sync failed:"));
    } catch (e) {
        logger.error({ err: e }, "❌ Pre-audit sync error");
    }

    await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `⏳ Preparing Monobank caches for ${dateStr}...`
    ).catch(() => { });

    // Ensure pre-warm is finished (likely already done while DDS sync ran).
    await preWarmPromise;

    await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `⏳ Running full FOP audit for ${dateStr}...`
    ).catch(() => { });

    const { reconciliationService } = await import("../../services/finance/reconciliation-service.js");

    // Aggregate wait statuses to prevent flickering when multiple FOPs wait
    const waitStatuses: Record<string, string> = { general: `⏳ Running full FOP audit for ${dateStr}...` };
    let lastUpdate = 0;

    const onProgress = async (msg: string) => {
        const fopMatch = msg.match(/\[(.*?)\]/);
        const key = (fopMatch && fopMatch[1]) ? fopMatch[1].toUpperCase() : 'general';
        waitStatuses[key] = msg;

        const combined = Object.entries(waitStatuses)
            .sort(([keyA], [keyB]) => {
                if (keyA === 'general') return -1;
                if (keyB === 'general') return 1;
                return keyA.localeCompare(keyB);
            })
            .map(([_, val]) => val)
            .filter(Boolean)
            .join('\n\n');

        const now = Date.now();
        if (now - lastUpdate > 1500) {
            lastUpdate = now;
            await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, combined).catch(() => { });
        }
    };

    const res = await reconciliationService.runReconciliation(dateStr, undefined, onProgress, incomes);

    if (!res.success) {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => { });
        return ctx.reply(`❌ Error: ${res.message}`);
    }

    const reports = reconciliationService.formatReconReport(dateStr, res);

    try {
        await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => { });

        let options: any = { parse_mode: "HTML" };
        if (reports.actions && reports.actions.length > 0) {
            options.reply_markup = new InlineKeyboard().text(`⚙️ Audit Actions (${reports.actions.length})`, `admin_audit_actions:${dateStr}`);
            await redis.set(`audit:actions:${dateStr}`, JSON.stringify(reports.actions), 'EX', 86400);
        }

        await ctx.reply(reports.main || `No data found for ${dateStr}.`, options);

        for (const chunk of reports.unrecognized) {
            await ctx.reply(chunk, { parse_mode: "HTML" });
        }

        for (const chunk of reports.expenses) {
            await ctx.reply(chunk, { parse_mode: "HTML" });
        }
    } catch (error: any) {
        logger.error({ err: error }, "❌ Audit Error:");
        await ctx.reply(`❌ Error: ${error.message}`);
    }
}

// --- DDS SYNC MENU (Super Admin only) ---
export const adminDdsSyncMenu = new Menu<MyContext>("admin-dds-sync")
    .text("📅 Today", async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => { });
        await runDdsSyncForDate(ctx, new Date());
    })
    .text("📅 Yesterday", async (ctx) => {
        await ctx.answerCallbackQuery().catch(() => { });
        const d = new Date();
        d.setDate(d.getDate() - 1);
        await runDdsSyncForDate(ctx, d);
    })
    .row()
    .text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "💰 <b>Finance & Audit</b>", "admin-finance");
    });

async function runDdsSyncForDate(ctx: MyContext, date: Date) {
    const dateStr = date.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    const statusMsg = await ctx.reply(ADMIN_TEXTS["admin-finance-syncing-dds"]({ date: dateStr }));

    try {
        const { syncToDDS } = await import("../../services/finance-report.js");
        const result = await syncToDDS(dateStr);

        await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            result.success
                ? `✅ DDS sync for ${dateStr} complete.\n${result.message}`
                : `❌ DDS sync failed: ${result.message}`
        ).catch(() => { });
    } catch (e: any) {
        logger.error({ err: e }, "❌ DDS Sync Error:");
        await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `❌ Error: ${e.message}`).catch(() => { });
    }
}
