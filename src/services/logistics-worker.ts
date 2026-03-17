import { Bot } from "grammy";
import { logisticsService } from "./logistics-service.js";
import logger from "../core/logger.js";

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startLogisticsLoop(bot: Bot) {
    logger.info("📦 Starting Logistics Sync Loop (every 1h)");
    
    // Immediate sync on startup
    logisticsService.syncIncomingParcels().catch(err => {
        logger.error({ err }, "Failed to perform initial logistics sync");
    });

    setInterval(async () => {
        try {
            await logisticsService.syncIncomingParcels();
        } catch (error) {
            logger.error({ err: error }, "Error in logistics sync loop");
        }
    }, SYNC_INTERVAL_MS);
}
