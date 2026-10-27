import { Composer, InlineKeyboard } from "grammy";
import { Menu } from "@grammyjs/menu";
import type { MyContext } from "../../types/context.js";
import { broadcastService, type BroadcastStats } from "../../services/broadcast.js";
import { ADMIN_TEXTS } from "../../constants/admin-texts.js";
import { ScreenManager } from "../../utils/screen-manager.js";
import { broadcastComposeHandlers, startStatelessBroadcast } from "./broadcast-compose.js";

// Создание рассылки (Кому → Ответ → Сообщение → Предпросмотр) живёт в broadcast-compose.ts.
export { startStatelessBroadcast, handleBroadcastContent, renderCitySelection } from "./broadcast-compose.js";

export const adminBroadcastHandlers = new Composer<MyContext>();
adminBroadcastHandlers.use(broadcastComposeHandlers);
const ARCHIVE_LIST_LIMIT = 500;
const ARCHIVE_PAGE_SIZE = 8;

// --- MENUS (Declared first to avoid cycles) ---
export const adminBroadcastHubMenu = new Menu<MyContext>("admin-broadcast-hub");
export const adminBroadcastListMenu = new Menu<MyContext>("admin-broadcast-list");
export const adminBroadcastArchiveMenu = new Menu<MyContext>("admin-broadcast-archive");
export const adminBroadcastManageMenu = new Menu<MyContext>("admin-broadcast-manage");

function getPendingCount(broadcast: any): number {
    return broadcast.trackedMessages?.reduce((acc: number, tracked: any) =>
        acc + (tracked.pendingReplies?.filter((reply: any) => reply.status === "pending").length || 0), 0) || 0;
}

/** Снимать можно только ещё не снятую рассылку. */
export function canWithdraw(stats: Pick<BroadcastStats, "withdrawnAt">): boolean {
    return !stats.withdrawnAt;
}

function isBroadcastActive(broadcast: any): boolean {
    if (broadcast.withdrawnAt) return false;
    const hasActivePing = broadcast.trackedMessages?.some((tracked: any) => Boolean(tracked.nextPingAt)) || false;
    return hasActivePing || getPendingCount(broadcast) > 0;
}

function formatBroadcastStats(broadcastId: number, stats: BroadcastStats, footer?: string): string {
    const withdrawn = stats.withdrawnAt
        ? `↩️ Withdrawn: <b>${stats.withdrawnAt.toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit', year: 'numeric' })}</b>\n\n`
        : "";
    return `📊 <b>Broadcast Statistics (ID: ${broadcastId})</b>\n\n` +
        withdrawn +
        `📨 Delivery targets: <b>${stats.deliveryTotal}</b>\n` +
        `✅ Delivered: <b>${stats.deliverySent}</b>\n` +
        `⚠️ Failed: <b>${stats.deliveryFailed}</b>\n` +
        `❔ Pending/uncertain: <b>${stats.deliveryUncertain}</b>\n` +
        `⏭ Skipped: <b>${stats.deliverySkipped}</b>\n\n` +
        `🌐 Tracked chats: <b>${stats.totalChats}</b>\n` +
        `✅ Confirmed: <b>${stats.confirmed}</b>\n` +
        `❌ Declined: <b>${stats.declined}</b>\n` +
        `⏳ Awaiting response: <b>${stats.pending}</b>` +
        (footer ? `\n\n${footer}` : "");
}

adminBroadcastHandlers.callbackQuery("br_to_hub", async (ctx) => {
    await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
    await ctx.answerCallbackQuery().catch(() => { });
});

adminBroadcastHandlers.callbackQuery("br_back_to_main", async (ctx) => {
    await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
    await ctx.answerCallbackQuery().catch(() => { });
});

// --- MENU IMPLEMENTATIONS ---

adminBroadcastListMenu.dynamic(async (ctx, range) => {
    const broadcasts = await broadcastService.getRecentBroadcasts(100);
    const activeBroadcasts = broadcasts.filter((broadcast: any) => isBroadcastActive(broadcast)).slice(0, 10);

    if (activeBroadcasts.length === 0) {
        range.text("✅ No active pings", (ctx) => ctx.answerCallbackQuery().catch(() => { })).row();
    }
    else {
        activeBroadcasts.forEach((b: any) => {
            const date = new Date(b.createdAt).toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
            const pending = getPendingCount(b);
            const label = `🔔 ${date} #${b.id} | ⏳${pending} | ${b.targetSummary || 'Broadcast'}`;

            range.text(label, async (ctx) => {
                if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
                ctx.session.candidateData.city = b.id.toString();

                const stats = await broadcastService.getStats(b.id);
                const statsText = formatBroadcastStats(
                    b.id,
                    stats,
                    `<i>Last updated: ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</i>`,
                );

                await ScreenManager.renderScreen(ctx, statsText, "admin-broadcast-manage", { pushToStack: true });
            }).row();
        });
    }

    range.text("🗂 Completed Archive", async (ctx) => {
        (ctx.session as any).broadcastArchivePage = 0;
        await ScreenManager.renderScreen(ctx, "🗂 <b>Completed Broadcasts</b>", "admin-broadcast-archive", { pushToStack: true });
    }).row();

    range.text("⏹ Stop All Active Pings", async (ctx) => {
        const confirmKb = new InlineKeyboard()
            .text("✅ Yes, stop all", "br_stop_all_pings_exec").danger().row()
            .text("✖️ Cancel", "br_stop_all_pings_cancel").danger();

        await ScreenManager.renderScreen(
            ctx,
            "⚠️ <b>Stop all active pings?</b>\n\nThis will disable auto-repeat for every current broadcast.",
            confirmKb,
            { pushToStack: true }
        );
    }).row()
        .text("⬅️ Back", async (ctx) => {
            await ScreenManager.goBack(ctx, "📢 <b>Broadcast Hub</b>", "admin-broadcast-hub");
        });
});

adminBroadcastHubMenu.dynamic(async (ctx, range) => {
    range.text("New announcement", async (ctx) => {
        await startStatelessBroadcast(ctx);
    }).row();

    range.text("Active", async (ctx) => {
        await ScreenManager.renderScreen(ctx, "📜 <b>Active Broadcasts</b>", "admin-broadcast-list", { pushToStack: true });
    }).row();
    range.text("Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "🛠️ <b>System Settings</b>", "admin-system");
    });
});

adminBroadcastArchiveMenu.dynamic(async (ctx, range) => {
    const broadcasts = await broadcastService.getRecentBroadcasts(ARCHIVE_LIST_LIMIT);
    const completedBroadcasts = broadcasts.filter((broadcast: any) => !isBroadcastActive(broadcast));
    const totalPages = Math.max(1, Math.ceil(completedBroadcasts.length / ARCHIVE_PAGE_SIZE));
    const requestedPage = Number((ctx.session as any).broadcastArchivePage || 0);
    const page = Math.min(Math.max(requestedPage, 0), totalPages - 1);
    (ctx.session as any).broadcastArchivePage = page;
    const pageItems = completedBroadcasts.slice(page * ARCHIVE_PAGE_SIZE, (page + 1) * ARCHIVE_PAGE_SIZE);

    if (pageItems.length === 0) {
        range.text("✅ Archive is empty", async (ctx) => {
            await ctx.answerCallbackQuery().catch(() => { });
        }).row();
    } else {
        pageItems.forEach((broadcast: any) => {
            const date = new Date(broadcast.createdAt).toLocaleDateString("uk-UA", { day: '2-digit', month: '2-digit' });
            const label = `✅ ${date} #${broadcast.id} | ${broadcast.targetSummary || 'Broadcast'}`;

            range.text(label, async (ctx) => {
                if (!ctx.session.candidateData) ctx.session.candidateData = {} as any;
                ctx.session.candidateData.city = broadcast.id.toString();

                const stats = await broadcastService.getStats(broadcast.id);
                const statsText = formatBroadcastStats(broadcast.id, stats);
                await ScreenManager.renderScreen(ctx, statsText, "admin-broadcast-manage", { pushToStack: true });
            }).row();
        });
    }

    if (totalPages > 1) {
        if (page > 0) {
            range.text("⬅️ Prev", async (ctx) => {
                (ctx.session as any).broadcastArchivePage = page - 1;
                await ScreenManager.renderScreen(ctx, "🗂 <b>Completed Broadcasts</b>", "admin-broadcast-archive");
            });
        }
        if (page < totalPages - 1) {
            range.text("Next ➡️", async (ctx) => {
                (ctx.session as any).broadcastArchivePage = page + 1;
                await ScreenManager.renderScreen(ctx, "🗂 <b>Completed Broadcasts</b>", "admin-broadcast-archive");
            });
        }
        range.row();
    }

    range.text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "📜 <b>Active Broadcasts</b>", "admin-broadcast-list");
    });
});

adminBroadcastHandlers.callbackQuery("br_stop_all_pings_exec", async (ctx) => {
    const stopped = await broadcastService.stopAllPings();
    await ctx.answerCallbackQuery("Done").catch(() => { });
    await ScreenManager.renderScreen(ctx, `⏹️ <b>Active pings stopped:</b> ${stopped}`, "admin-broadcast-list");
});

adminBroadcastHandlers.callbackQuery("br_stop_all_pings_cancel", async (ctx) => {
    await ctx.answerCallbackQuery("Cancelled").catch(() => { });
    await ScreenManager.goBack(ctx, "📜 <b>Active Broadcasts</b>", "admin-broadcast-list");
});

export async function handleWithdrawExec(ctx: MyContext, bId: number): Promise<void> {
    if (!Number.isInteger(bId) || bId <= 0) {
        await ctx.answerCallbackQuery("Session expired.").catch(() => { });
        return;
    }

    const result = await broadcastService.withdrawBroadcast(ctx.api, bId, ctx.from!.id);
    await ctx.answerCallbackQuery("↩️ Withdrawn.").catch(() => { });

    const stats = await broadcastService.getStats(bId);
    const footer = ADMIN_TEXTS["broadcast-withdraw-result"]({
        deleted: result.deleted,
        failed: result.failed,
        album: (stats.attachmentCount ?? 0) > 1,
    });
    await ScreenManager.renderScreen(ctx, formatBroadcastStats(bId, stats, footer), "admin-broadcast-manage");
}

export async function handleWithdrawCancel(ctx: MyContext, bId: number): Promise<void> {
    await ctx.answerCallbackQuery("Cancelled").catch(() => { });
    if (!Number.isInteger(bId) || bId <= 0) {
        await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
        return;
    }
    const stats = await broadcastService.getStats(bId);
    await ScreenManager.renderScreen(ctx, formatBroadcastStats(bId, stats), "admin-broadcast-manage");
}

adminBroadcastHandlers.callbackQuery(/^br_withdraw_exec_(\d+)$/, async (ctx) => {
    await handleWithdrawExec(ctx, Number(ctx.match[1]));
});

adminBroadcastHandlers.callbackQuery(/^br_withdraw_cancel_(\d+)$/, async (ctx) => {
    await handleWithdrawCancel(ctx, Number(ctx.match[1]));
});

adminBroadcastManageMenu.dynamic(async (ctx, range) => {
    const bId = Number(ctx.session.candidateData?.city);
    if (!bId) return;

    range.text("🔄 Refresh Stats", async (ctx) => {
        const freshStats = await broadcastService.getStats(bId);
        const freshText = formatBroadcastStats(
            bId,
            freshStats,
            `<i>Last updated: ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</i>`,
        );

        await ScreenManager.renderScreen(ctx, freshText, "admin-broadcast-manage");
    }).row()
        .text("⏹ Stop Pings", async (ctx) => {
            await broadcastService.stopPinging(bId);
            await ctx.answerCallbackQuery("Pings stopped").catch(() => { });

            const freshStats = await broadcastService.getStats(bId);
            const freshText = formatBroadcastStats(
                bId,
                freshStats,
                "⏹️ <b>Auto-pings are stopped for this broadcast.</b>",
            );
            await ScreenManager.renderScreen(ctx, freshText, "admin-broadcast-manage");
        }).row();
    // Уже снятую рассылку снимать нечем: кнопка только вводила бы в заблуждение.
    if (canWithdraw(await broadcastService.getStats(bId))) {
        range.text("↩️ Withdraw", async (ctx) => {
            const confirmKb = new InlineKeyboard()
                .text(ADMIN_TEXTS["broadcast-withdraw-confirm-btn"], `br_withdraw_exec_${bId}`).danger().row()
                .text(ADMIN_TEXTS["broadcast-withdraw-cancel-btn"], `br_withdraw_cancel_${bId}`).danger();
            await ScreenManager.renderScreen(ctx, ADMIN_TEXTS["broadcast-withdraw-confirm"], confirmKb, { pushToStack: true });
        }).row();
    }
    range.text("⬅️ Back", async (ctx) => {
        await ScreenManager.goBack(ctx, "📜 <b>Broadcast History</b>", "admin-broadcast-list");
    });
});

