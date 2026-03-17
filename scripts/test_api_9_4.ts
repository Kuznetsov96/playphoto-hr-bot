import { InlineKeyboard } from "grammy";

const keyboard = new InlineKeyboard()
    .text("Primary", "cb")
    // @ts-ignore - style is new in Bot API 9.4
    .text({ text: "Blue", callback_data: "blue", style: "primary" })
    // @ts-ignore
    .text({ text: "Red", callback_data: "red", style: "destructive" });

console.log("Keyboard JSON:", JSON.stringify(keyboard, null, 2));
