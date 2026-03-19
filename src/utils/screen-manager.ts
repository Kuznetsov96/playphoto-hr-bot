import { Context, InlineKeyboard } from "grammy";
import type { MyContext, MenuId, StackEntry, SessionData } from "../types/context.js";
import logger from "../core/logger.js";
import { menuRegistry } from "./menu-registry.js";

/**
 * ScreenManager implements the "Single Message Interface" (SMI) pattern.
 * It manages transitions between UI screens, maintains a navigation stack with state preservation,
 * and handles common Telegram API errors.
 */
export class ScreenManager {
    /**
     * Fields from session that should be preserved in the navigation stack.
     */
    private static readonly PRESERVED_FIELDS: (keyof SessionData)[] = [
        'selectedUserId',
        'selectedCandidateId',
        'selectedLocationId',
        'selectedSlotId',
        'selectedDate',
        'selectedOnboardingDate',
        'candidatePage',
        'broadcastCity',
        'broadcastLocationId'
    ];

    /**
     * Renders a screen. 
     */
    static async renderScreen(
        ctx: MyContext, 
        text: string, 
        reply_markup?: any, 
        options: { pushToStack?: boolean; forceNew?: boolean; photoId?: string | null; manualMenuId?: string } | boolean = {}
    ) {
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        let pushToStack = false;
        let forceNew = false;
        let photoId: string | null = null;
        let manualMenuId: string | null = null;

        if (typeof options === 'boolean') {
            forceNew = options;
        } else {
            pushToStack = options.pushToStack || false;
            forceNew = options.forceNew || false;
            photoId = options.photoId || null;
            manualMenuId = options.manualMenuId || null;
        }

        // 1. Manage Navigation Stack
        if (pushToStack && (reply_markup || manualMenuId)) {
            const menuId = manualMenuId || (typeof reply_markup === 'string' ? reply_markup : (reply_markup as any)?.id);
            if (typeof menuId === 'string') {
                const lastEntry = ctx.session.navStack[ctx.session.navStack.length - 1];
                
                if (!lastEntry || lastEntry.menuId !== menuId) {
                    // Create a snapshot of the CURRENT state
                    const stateSnapshot: any = {};
                    this.PRESERVED_FIELDS.forEach(field => {
                        const val = (ctx.session as any)[field];
                        if (val !== undefined) {
                            stateSnapshot[field] = JSON.parse(JSON.stringify(val));
                        }
                    });

                    ctx.session.navStack.push({ menuId: menuId as MenuId, state: stateSnapshot });
                    if (ctx.session.navStack.length > 15) ctx.session.navStack.shift();
                }
            }
        }

        // 2. Automatic Garbage Collection (Parallel & Non-blocking)
        if ((forceNew || photoId) && ctx.session.messagesToDelete && ctx.session.messagesToDelete.length > 0) {
            const ids = [...ctx.session.messagesToDelete];
            ctx.session.messagesToDelete = [];
            // Don't await deletions, do them in parallel
            Promise.allSettled(ids.map(id => ctx.api.deleteMessage(chatId, id).catch(() => {})));
        }

        try {
            const previousMsgId = ctx.session.messagesToDelete ? ctx.session.messagesToDelete[ctx.session.messagesToDelete.length - 1] : null;
            let actualMarkup = typeof reply_markup === 'string' ? menuRegistry.get(reply_markup) : reply_markup;
            const canEdit = !forceNew && !photoId && ctx.callbackQuery && ctx.callbackQuery.message && !ctx.callbackQuery.message.photo;

            if (canEdit) {
                // Ensure reply_markup is compatible with editMessageText
                const markup = (actualMarkup instanceof InlineKeyboard) ? actualMarkup : (actualMarkup as any);

                // ATOMIC UPDATE: Single call for both text and buttons
                await ctx.editMessageText(text, {
                    parse_mode: "HTML",
                    reply_markup: markup || undefined,
                    link_preview_options: { is_disabled: true }
                });
            } else {                if (ctx.callbackQuery && ctx.callbackQuery.message) {
                    await ctx.api.deleteMessage(chatId, ctx.callbackQuery.message.message_id).catch(() => {});
                } else if (previousMsgId) {
                    await ctx.api.deleteMessage(chatId, previousMsgId).catch(() => {});
                    ctx.session.messagesToDelete = ctx.session.messagesToDelete.filter(id => id !== previousMsgId);
                }

                let msg;
                if (photoId) {
                    msg = await ctx.replyWithPhoto(photoId, {
                        caption: text,
                        parse_mode: "HTML",
                        reply_markup: actualMarkup || undefined
                    });
                } else {
                    msg = await ctx.reply(text, {
                        parse_mode: "HTML",
                        reply_markup: actualMarkup || undefined,
                        link_preview_options: { is_disabled: true }
                    });
                }

                if (!ctx.session.messagesToDelete) ctx.session.messagesToDelete = [];
                ctx.session.messagesToDelete.push(msg.message_id);
            }
        } catch (e: any) {
            const errorMsg = e.message || "";
            if (errorMsg.includes("message is not modified")) {
                await ctx.answerCallbackQuery().catch(() => {});
                return;
            }

            logger.error({ err: e, menuId: typeof reply_markup === 'string' ? reply_markup : 'obj' }, "renderScreen: Transition failed");
            
            try {
                const actualMarkup = typeof reply_markup === 'string' ? menuRegistry.get(reply_markup) : reply_markup;
                const msg = await ctx.reply(text, {
                    parse_mode: "HTML",
                    reply_markup: actualMarkup || undefined,
                    link_preview_options: { is_disabled: true }
                });
                if (!ctx.session.messagesToDelete) ctx.session.messagesToDelete = [];
                ctx.session.messagesToDelete.push(msg.message_id);
            } catch (replyError) {
                logger.error({ err: replyError }, "renderScreen: Emergency recovery failed");
            }
        }
    }

    /**
     * Pops the last screen from the stack and navigates to it, restoring associated state.
     */
    static async goBack(ctx: MyContext, fallbackText: string, fallbackMenuOrId?: any) {
        const navigateTo = async (entry: StackEntry | string, text: string) => {
            const menuId = typeof entry === 'string' ? entry : entry.menuId;
            const state = typeof entry === 'string' ? null : entry.state;
            
            // Restore state if available
            if (state) {
                Object.assign(ctx.session, state);
                logger.debug({ menuId, state }, "Restored state during navigation");
            }

            const actualMarkup = typeof menuId === 'string' ? menuRegistry.get(menuId) : menuId;
            const markup = (actualMarkup instanceof InlineKeyboard) ? actualMarkup : (actualMarkup as any);
            
            try {
                // ATOMIC UPDATE: Change text and keyboard in ONE call to avoid flashing.
                await ctx.editMessageText(text, {
                    parse_mode: "HTML",
                    reply_markup: markup || undefined,
                    link_preview_options: { is_disabled: true }
                });
                return true;
            } catch (e: any) {
                if (e.message?.includes("message is not modified")) return true;
                // Fallback to fresh screen if editing fails
                await this.renderScreen(ctx, text, menuId, { forceNew: true });
                return true;
            }
        };

        if (!ctx.session.navStack || ctx.session.navStack.length === 0) {
            ctx.session.navStack = [];
            
            if (fallbackMenuOrId) {
                await navigateTo(fallbackMenuOrId, fallbackText);
            } else {
                // Determine module context for better fallback
                const isHR = ctx.session.step?.startsWith('hr_') || ctx.session.candidateData;
                if (isHR) {
                    try {
                        const { hrService } = await import("../services/hr-service.js");
                        const text = await hrService.getHubText();
                        await navigateTo('hr-hub-menu', text);
                    } catch (e) {
                        await navigateTo('admin-main', "🤖 <b>PlayPhoto Admin</b>");
                    }
                } else {
                    // Absolute fallback to main admin menu
                    await navigateTo('admin-main', "🤖 <b>PlayPhoto Admin</b>");
                }
            }
            return;
        }

        // 1. Pop the CURRENT screen (the one we are leaving)
        ctx.session.navStack.pop();
        
        // 2. Look at what's now at the top
        const previousEntry = ctx.session.navStack[ctx.session.navStack.length - 1];
        
        if (previousEntry) {
            await navigateTo(previousEntry, fallbackText);
        } else if (fallbackMenuOrId) {
            await navigateTo(fallbackMenuOrId, fallbackText);
        }
    }

    static async renderError(ctx: MyContext, text: string) {
        const kb = new InlineKeyboard().text("🏠 Меню", "staff_hub_nav");
        await this.renderScreen(ctx, text, kb, { forceNew: true });
    }

    static async showUnknownCommand(ctx: MyContext) {
        const text = "🐾 <b>Ой! Я не зовсім зрозумів цю команду.</b>\n\nБудь ласка, використовуйте кнопки меню або натисніть /start, щоб повернутися в головне меню. ✨";
        const kb = new InlineKeyboard().text("🏠 Меню", "staff_hub_nav");
        await this.renderScreen(ctx, text, kb);
    }
}
