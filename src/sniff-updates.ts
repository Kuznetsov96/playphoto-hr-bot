import { Bot } from "grammy";
import fetch from "node-fetch";

export async function sniffUpdates(bot: Bot<any>) {
    console.log("🕵️‍♂️ Починаю прослуховування оновлень...");
    try {
        const token = bot.token;
        const url = `https://api.telegram.org/bot${token}/getUpdates`;
        const res = await fetch(url + "?timeout=10&limit=10");
        const data = await res.json();
        console.log("📥 Отримано оновлень:", JSON.stringify(data, null, 2));
    } catch (e: any) {
        console.error("❌ Помилка API:", e.message);
    }
}
