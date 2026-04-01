import { Bot } from "grammy";
import { logisticsService } from "./logistics-service.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startLogisticsLoop(bot: Bot) {
    logBusinessEvent({
        event: "logistics.sync_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "logistics-worker",
        operation: "startLogisticsLoop",
        safeContext: {
            intervalMs: SYNC_INTERVAL_MS,
        },
    });
    
    // Immediate sync on startup
    logisticsService.syncIncomingParcels().catch(err => {
        logger.error({ err }, "Initial logistics sync failed");
        logBusinessEvent({
            event: "logistics.sync_iteration.completed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            reasonCode: "INITIAL_SYNC_FAILED",
            module: "logistics-worker",
            operation: "startLogisticsLoop",
            error: err,
        });
    });

    setInterval(async () => {
        try {
            await logisticsService.syncIncomingParcels();
            logBusinessEvent({
                event: "logistics.sync_iteration.completed",
                actorType: "system",
                actorRole: "system",
                result: "success",
                module: "logistics-worker",
                operation: "startLogisticsLoop",
            });
        } catch (error) {
            logger.error({ err: error }, "Logistics sync loop iteration failed");
            logBusinessEvent({
                event: "logistics.sync_iteration.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "SYNC_LOOP_FAILED",
                module: "logistics-worker",
                operation: "startLogisticsLoop",
                error,
            });
        }
    }, SYNC_INTERVAL_MS);
}
