import * as dotenv from "dotenv";
dotenv.config();

import { bot } from "./src/core/bot.js";
import { handlers } from "./src/handlers/index.js";
import { hrHubMenu } from "./src/menus/hr.js";
import { staffMenu } from "./src/handlers/staff-menu.js";
import { adminMenu } from "./src/handlers/admin/index.js";
import { mentorHubMenu } from "./src/menus/mentor.js";
import { redis } from "./src/core/redis.js";
import prisma from "./src/db/core.js";

async function run() {
    console.log("Connecting DB...");
    await prisma.$connect();
    console.log("Connecting Redis...");
    await redis.connect();
    
    bot.use(adminMenu);
    bot.use(staffMenu);
    bot.use(hrHubMenu);
    bot.use(mentorHubMenu);
    bot.use(handlers);
    
    console.log("Simulating /start update...");
    const update = {
        update_id: 123456,
        message: {
            message_id: 1,
            from: { id: 7416029746, is_bot: false, first_name: "Test" },
            chat: { id: 7416029746, type: "private" },
            date: Date.now() / 1000,
            text: "/start"
        }
    };
    
    // Process update through the bot mw stack manually
    try {
        await bot.handleUpdate(update as any);
        console.log("Update processed SUCCESSFULLY.");
    } catch (e) {
        console.error("Update process FULLY FAILED:", e);
    }
    
    console.log("Disconnecting...");
    await redis.quit();
    await prisma.$disconnect();
}

run().catch(console.error);
