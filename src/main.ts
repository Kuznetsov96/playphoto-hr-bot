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
import { startWorker, startScheduleNotificationDispatcher, startReplacementNotificationDispatcher, startShootAlertDispatcher, startShootTaskDispatcher, startAccessRevocationDispatcher, startRecruitingCommandDispatcher, startRecruitingMirrorSweep, startReplacementStatusSweep, startStaffActivationSweep } from "./services/worker.js";
import { startBirthdayLoop } from "./services/birthday-service.js";
import { startShiftReminderLoop } from "./services/shift-reminder-service.js";
import { startScheduleMirrorWatch } from "./services/stale-schedule-mirror.js";
import { startDailyReportLoop } from "./services/finance-report.js";
import { startPingerLoop } from "./services/pinger.js";
import { startMonthlyPreferencesLoop } from "./services/monthly-preferences-trigger.js";
import { startLogisticsLoop } from "./services/logistics-worker.js";
import { startLogCleanupLoop } from "./services/log-cleanup-service.js";
import { startAuditCleanupLoop } from "./services/audit-cleanup-service.js";
import { startChatLogRetentionLoop } from "./services/chat-log-retention-service.js";
import { startSecurityCleanupLoop } from "./services/security-cleanup-service.js";
import { startWorkers } from "./workers/index.js";
import { queues } from "./core/queue.js";
import { configureContainer } from "./core/container.js";
import { webhookService } from "./services/webhook-service.js";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { ADMIN_IDS, BUSINESS_DATA_SOURCE, SUPPORT_THREADS_ENABLED } from "./config.js";
import { awsBusinessSyncService } from "./services/aws-business-sync.js";
import { reconcileKnownChats } from "./services/known-chat-reconciler.js";

let runner: RunnerHandle | undefined;
let queueWorkers: ReturnType<typeof startWorkers> = [];
let shuttingDown = false;
let awsBusinessSyncTimer: NodeJS.Timeout | undefined;
let shiftReminderTimer: NodeJS.Timeout | undefined;
let scheduleNotificationTimer: NodeJS.Timeout | undefined;
let replacementNotificationTimer: NodeJS.Timeout | undefined;
let shootAlertTimer: NodeJS.Timeout | undefined;
let shootTaskPoller: ReturnType<typeof startShootTaskDispatcher> | undefined;
let accessRevocationTimer: NodeJS.Timeout | undefined;
let recruitingCommandTimer: NodeJS.Timeout | undefined;
let recruitingMirrorSweepTimer: NodeJS.Timeout | undefined;
let replacementStatusSweepTimer: NodeJS.Timeout | undefined;
let staffActivationSweepTimer: NodeJS.Timeout | undefined;
let scheduleMirrorTimer: NodeJS.Timeout | undefined;

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

        if (BUSINESS_DATA_SOURCE === "aws") {
            await awsBusinessSyncService.syncAll();
            awsBusinessSyncTimer = awsBusinessSyncService.startLoop();
        }

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
        
        // NOTE: The recruiter's own HR hub (hrHubMenu) was removed 2026-09-03,
        // the mentor menu — 2026-09-09: навчання й найм ведуться у вебзастосунку.
        // What remains in menus/hr.ts (Final Step Pipeline, candidate detail
        // views) is registered via the admin bootstrap, not here.

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
        scheduleNotificationTimer = startScheduleNotificationDispatcher(bot as any);
        replacementNotificationTimer = startReplacementNotificationDispatcher(bot as any);
        shootAlertTimer = startShootAlertDispatcher(bot as any);
        shootTaskPoller = startShootTaskDispatcher(bot as any);
        accessRevocationTimer = startAccessRevocationDispatcher(bot as any);
        recruitingCommandTimer = startRecruitingCommandDispatcher(bot as any);
        recruitingMirrorSweepTimer = startRecruitingMirrorSweep();
        replacementStatusSweepTimer = startReplacementStatusSweep(bot.api);
        staffActivationSweepTimer = startStaffActivationSweep(bot.api);
        startBirthdayLoop(bot);
        shiftReminderTimer = startShiftReminderLoop(bot);
        // Nothing else notices when the schedule sync dies: the loop swallows its
        // own failure into a log line, and a timer that stops firing produces no
        // log at all. The bot would keep serving the last-written schedule.
        scheduleMirrorTimer = startScheduleMirrorWatch(bot.api, ADMIN_IDS);
        startDailyReportLoop(bot);
        startPingerLoop(bot);
        startMonthlyPreferencesLoop(bot);
        startLogisticsLoop(bot as any);
        startLogCleanupLoop();
        startAuditCleanupLoop();
        startChatLogRetentionLoop();
        startSecurityCleanupLoop();
        
        webhookService.listen(bot.api);
        queueWorkers = startWorkers();

        // Сверка реестра при старте. Не ждём её: сбой Telegram во время сверки не
        // должен задерживать запуск, фотографы обслуживаются, пока она идёт фоном.
        //
        // Плата за это — гонка, и она реальна: `run(bot, …)` стартует строкой ниже,
        // а `deleteWebhook({ drop_pending_updates: false })` намеренно сохраняет
        // накопленный бэклог, так что очередь `my_chat_member` начинает разбираться,
        // пока сверка ещё идёт по чатам. Опасно одно направление: событие о
        // возврате в чат уже проставило `lostAt = null`, а сверка следом получает
        // транзиентный отказ `getChatMember` по тому же чату и своим `recordLost`
        // затирает свежий верный вердикт устаревшим неверным. Чат выпадает из
        // `listActive()`, и уволенный сохраняет к нему доступ.
        //
        // Терпим сознательно: `autoRetry` подключён глобально (`src/core/bot.ts:29`),
        // сверка наследует backoff по 429, поэтому сам триггер — транзиентный отказ —
        // маловероятен; окно узкое (одна проходка по чатам на старте); состояние
        // самолечится на следующем рестарте, когда сверка отработает без гонки.
        reconcileKnownChats(bot.api)
            .then((result) => {
                logBusinessEvent({
                    event: "known_chat.reconcile.startup",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "main",
                    operation: "reconcileKnownChats",
                    safeContext: { ...result },
                });
            })
            .catch((error) => {
                logger.error({ err: error }, "known-chat-reconciler: startup sweep failed");
            });

        // Start the bot with runner for parallel processing
        runner = run(bot, {
            runner: {
                fetch: {
                    // Правки й реакції потрібні лише постійним темам підтримки: без
                    // прапорця їх не просимо, щоб старий маршрут їх не бачив зовсім.
                    allowed_updates: [
                        "message", "callback_query", "my_chat_member", "chat_member", "chat_join_request",
                        ...(SUPPORT_THREADS_ENABLED ? (["edited_message", "message_reaction"] as const) : []),
                    ]
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

const SHOOT_TASK_STOP_TIMEOUT_MS = 10_000;

async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`\n🛑 [SHUTDOWN] Отримано сигнал ${signal}. Зупинка бота...`);

    try {
        if (awsBusinessSyncTimer) clearInterval(awsBusinessSyncTimer);
        if (scheduleNotificationTimer) clearInterval(scheduleNotificationTimer);
        if (replacementNotificationTimer) clearInterval(replacementNotificationTimer);
        if (shootAlertTimer) clearInterval(shootAlertTimer);
        if (accessRevocationTimer) clearInterval(accessRevocationTimer);
        if (recruitingCommandTimer) clearInterval(recruitingCommandTimer);
        if (recruitingMirrorSweepTimer) clearInterval(recruitingMirrorSweepTimer);
        if (replacementStatusSweepTimer) clearInterval(replacementStatusSweepTimer);
        if (staffActivationSweepTimer) clearInterval(staffActivationSweepTimer);
        if (scheduleMirrorTimer) clearInterval(scheduleMirrorTimer);
        if (shiftReminderTimer) clearInterval(shiftReminderTimer);
        // Опитування зйомок у польоті дописує пару в Redis — чекаємо його до redis.quit().
        if (shootTaskPoller && !(await shootTaskPoller.stop(SHOOT_TASK_STOP_TIMEOUT_MS))) {
            logger.warn("Shoot task poll still in flight after shutdown timeout");
        }
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
