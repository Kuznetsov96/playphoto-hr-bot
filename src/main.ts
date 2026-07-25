import * as dotenv from "dotenv";
(BigInt.prototype as any).toJSON = function () {
    return this.toString();
};

dotenv.config({ quiet: true });

import logger from "./core/logger.js";
import { logBusinessEvent } from "./core/log-events.js";

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
import { startLogCleanupLoop } from "./services/log-cleanup-service.js";
import { startAuditCleanupLoop } from "./services/audit-cleanup-service.js";
import { startChatLogRetentionLoop } from "./services/chat-log-retention-service.js";
import { startSecurityCleanupLoop } from "./services/security-cleanup-service.js";
import { remindersService } from "./services/reminders-service.js";
import { startWorkers } from "./workers/index.js";
import { queues } from "./core/queue.js";
import { configureContainer } from "./core/container.js";
import { webhookService } from "./services/webhook-service.js";
import { run, type RunnerHandle } from "@grammyjs/runner";

let runner: RunnerHandle | undefined;
let queueWorkers: ReturnType<typeof startWorkers> = [];
let shuttingDown = false;

async function bootstrap() {
    configureContainer();
    logBusinessEvent({
        event: "bot.bootstrap.started",
        actorType: "system",
        actorRole: "system",
        result: "started",
        module: "main",
        operation: "bootstrap",
    });

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

        if (redis.status === 'wait') {
            await redis.connect();
        }

        // 0. Register global menus FIRST so they are available to handlers
        logBusinessEvent({
            event: "bot.menus.registration.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "main",
            operation: "registerMenus",
        });
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

        logBusinessEvent({
            event: "bot.menus.registration.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "main",
            operation: "registerMenus",
        });

        // 1. Register handlers
        logBusinessEvent({
            event: "bot.handlers.registration.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "main",
            operation: "registerHandlers",
        });
        const { handlers } = await import("./handlers/index.js");
        bot.use(handlers);
        logBusinessEvent({
            event: "bot.handlers.registration.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "main",
            operation: "registerHandlers",
        });

        // Switch from webhook mode without discarding updates accumulated during downtime.
        await bot.api.deleteWebhook({ drop_pending_updates: false });
        logBusinessEvent({
            event: "bot.webhook.cleared",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "main",
            operation: "deleteWebhook",
            safeContext: { pendingUpdatesPreserved: true },
        });

        // Start background services
        startWorker(bot as any);
        startBirthdayLoop(bot);
        startShiftReminderLoop(bot);
        startDailyReportLoop(bot);
        startPingerLoop(bot);
        startMonthlyPreferencesLoop(bot);
        startLogisticsLoop(bot as any);
        startLogCleanupLoop();
        startAuditCleanupLoop();
        startChatLogRetentionLoop();
        startSecurityCleanupLoop();
        remindersService.startRemindersLoop(bot.api);
        
        webhookService.listen(bot.api);
        queueWorkers = startWorkers();

        // Start the bot with runner for parallel processing
        runner = run(bot, {
            runner: {
                fetch: {
                    allowed_updates: ["message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"]
                }
            }
        });

        if (runner.isRunning()) {
            logBusinessEvent({
                event: "bot.runner.started",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "main",
                operation: "startRunner",
                safeContext: {
                    bot: (await bot.api.getMe()).username,
                },
            });
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
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`\n🛑 [SHUTDOWN] Отримано сигнал ${signal}. Зупинка бота...`);

    try {
        if (runner?.isRunning()) {
            await runner.stop();
        }

        await webhookService.close();

        const closeResults = await Promise.allSettled([
            ...queueWorkers.map(worker => worker.close()),
            ...queues.map(queue => queue.close()),
        ]);
        for (const result of closeResults) {
            if (result.status === "rejected") {
                logger.error({ err: result.reason }, "Failed to close a queue resource cleanly");
            }
        }

        if (redis.status !== "end") {
            await redis.quit();
        }
        await prisma.$disconnect();
    } catch (error) {
        logger.error({ err: error }, "Error during graceful shutdown");
        process.exitCode = 1;
    } finally {
        process.exit(process.exitCode ?? 0);
    }
}

bootstrap();

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
