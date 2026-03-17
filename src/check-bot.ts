import * as dotenv from "dotenv";
dotenv.config();
import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("❌ BOT_TOKEN is missing in .env");
    process.exit(1);
}

console.log(`🔑 Token found (length: ${token.length})`);

const bot = new Bot(token);

async function check() {
    try {
        const me = await bot.api.getMe();
        console.log(`✅ Success! Bot connected as @${me.username} (ID: ${me.id})`);

        const updates = await bot.api.getUpdates({ limit: 1 });
        console.log(`📨 Pending updates: ${updates.length}`);
    } catch (e: any) {
        console.error(`❌ Connection failed: ${e.message}`);
    }
}

check();
