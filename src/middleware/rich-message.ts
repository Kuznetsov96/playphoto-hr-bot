import type { MiddlewareFn } from "grammy";
import type { MyContext } from "../types/context.js";
import { getRichMessageInputText } from "../utils/rich-message.js";

/** Makes semantic rich-message text available to all existing message:text flows. */
export const richMessageInputMiddleware: MiddlewareFn<MyContext> = async (ctx, next) => {
    const message = ctx.message;
    if (message?.rich_message && !message.text) {
        const text = getRichMessageInputText(message.rich_message);
        if (text) {
            (message as typeof message & { text?: string }).text = text;
        }
    }

    await next();
};
