import * as dotenv from "dotenv";
dotenv.config();

import logger from "./core/logger.js";

import { bot } from "./core/bot.js";
import { redis } from "./core/redis.js";
import prisma from "./db/core.js";
import { startWorker } from "./services/worker.js";
import { startBirthdayLoop } from "./services/birthday-service.js";
import { startShiftReminderLoop } from "./services/shift-reminder-service.js";
import { startDailyReportLoop } from "./services/finance-report.js";
import { startPingerLoop } from "./services/pinger.js";
import { startMonthlyPreferencesLoop } from "./services/monthly-preferences-trigger.js";
import { startLogisticsLoop } from "./services/logistics-worker.js";
import { remindersService } from "./services/reminders-service.js";
import { startWorkers } from "./workers/index.js";
import { configureContainer } from "./core/container.js";
import { webhookService } from "./services/webhook-service.js";
import { run, type RunnerHandle } from "@grammyjs/runner";

let runner: RunnerHandle | undefined;

async function bootstrap() {
    configureContainer();
    logger.info("🎬 Ініціалізація PlayPhoto HR Bot...");

    try {
        // 🛡️ CRITICAL CONFIGURATION CHECK
        const dbUrl = process.env.DATABASE_URL || "";
        const isProd = process.env.NODE_ENV === "production";

        if (isProd && (dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1"))) {
            const errorMsg =
                "\n🚨🚨🚨 CRITICAL CONFIGURATION ERROR 🚨🚨🚨\n" +
                "❌ You are running in PRODUCTION (Docker) but DATABASE_URL points to 'localhost'!\n" +
                "ℹ️  Docker container cannot see 'localhost' of the host.\n" +
                "🛠️  FIX: Update 'docker-compose.yml' -> services -> bot -> environment:\n" +
                "    - DATABASE_URL=postgresql://...:@postgres:5432/...\n" +
                "    (Use service name 'postgres' instead of 'localhost')\n" +
                "\n[BOT STOPPED TO PREVENT CRASH LOOP]";

            logger.fatal(errorMsg);
            console.error(errorMsg);
            process.exit(1);
        }

        await prisma.$connect();
        logger.info("✅ База даних підключена успішно!");

        if (redis.status === 'wait') {
            await redis.connect();
        }
        logger.info("✅ Redis Ready in Bootstrap!");

        // 0. Register global menus FIRST so they are available to handlers
        logger.info("🛠️ Registering menus...");
        const { registerAdminMenusHierarchy } = await import("./handlers/admin/bootstrap.js");
        await registerAdminMenusHierarchy(bot);
        
        // --- STAFF MENUS ---
        const { staffRootMenu } = await import("./menus/staff.js");
        bot.use(staffRootMenu);
        
        // --- HR MENUS ---
        const { hrHubMenu } = await import("./menus/hr.js");
        const { mentorRootMenu } = await import("./menus/mentor.js");
        
        bot.use(hrHubMenu);
        bot.use(mentorRootMenu);

        // --- CANDIDATE MENUS ---
        const { candidateGenderMenu } = await import("./menus/candidate.js");
        bot.use(candidateGenderMenu);

        logger.info("✅ ALL menus registered in bot and registry");

        // 1. Register handlers
        logger.info("🛠️ Registering handlers...");
        const { handlers } = await import("./handlers/index.js");
        bot.use(handlers);

        // Start background services
        startWorker(bot as any);
        startBirthdayLoop(bot);
        startShiftReminderLoop(bot);
        startDailyReportLoop(bot);
        startPingerLoop(bot);
        startMonthlyPreferencesLoop(bot);
        startLogisticsLoop(bot as any);
        remindersService.startRemindersLoop(bot.api);
        
        webhookService.listen(bot.api);
        startWorkers();

        // Ensure clean start
        await bot.api.deleteWebhook({ drop_pending_updates: true });
        logger.info("🧹 Webhook cleared");

        // Start the bot with runner for parallel processing
        runner = run(bot, {
            runner: {
                fetch: {
                    allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"]
                }
            }
        });

        if (runner.isRunning()) {
            logger.info({ bot: (await bot.api.getMe()).username }, "🚀 Бот запущений через Runner та готовий до роботи!");
        }

        // Configure persistent menu button
        await bot.api.setChatMenuButton({
            menu_button: { type: "commands" },
        });

        await bot.api.setMyCommands([
            { command: "start", description: "🏠 Головне меню" },
        ]);

    } catch (error) {
        logger.error({ err: error }, "❌ НЕ ВДАЛОСЯ запустити бота");
        process.exit(1);
    }
}

async function shutdown(signal: string) {
    logger.info(`\n🛑 [SHUTDOWN] Отримано сигнал ${signal}. Зупинка бота...`);
    if (runner?.isRunning()) {
        await runner.stop();
    }
    await prisma.$disconnect();
    process.exit(0);
}

bootstrap();

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
