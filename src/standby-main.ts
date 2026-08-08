import * as dotenv from "dotenv";
import { createServer } from "node:http";

dotenv.config({ quiet: true });

import { BUSINESS_DATA_SOURCE } from "./config.js";
import logger from "./core/logger.js";
import prisma from "./db/core.js";
import { awsBusinessSyncService } from "./services/aws-business-sync.js";

function writeEvent(event: string, details: Record<string, unknown> = {}) {
    logger.info({ event, ...details }, event);
}

async function main() {
    if (BUSINESS_DATA_SOURCE !== "aws") {
        throw new Error("Standby mode requires BUSINESS_DATA_SOURCE=aws");
    }

    let stopping = false;
    let resolveStop: (() => void) | undefined;
    const stopRequested = new Promise<void>((resolve) => {
        resolveStop = resolve;
    });
    const requestStop = (signal: string) => {
        if (stopping) return;
        stopping = true;
        writeEvent("bot.standby.stop_requested", { signal });
        resolveStop?.();
    };

    process.once("SIGTERM", () => requestStop("SIGTERM"));
    process.once("SIGINT", () => requestStop("SIGINT"));

    await prisma.$connect();
    const result = await awsBusinessSyncService.syncAll();
    const syncTimer = awsBusinessSyncService.startLoop();
    const healthServer = createServer((request, response) => {
        if (request.url !== "/health") {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ status: "ok", mode: "standby", telegramStarted: false }));
    });
    await new Promise<void>((resolve, reject) => {
        healthServer.once("error", reject);
        healthServer.listen(8080, "0.0.0.0", resolve);
    });

    writeEvent("bot.standby.ready", {
        businessSource: "AWS",
        employees: result.employees,
        locations: result.locations,
        shifts: result.shiftsAfter,
        telegramStarted: false,
        redisStarted: false,
        workersStarted: false,
    });

    await stopRequested;
    clearInterval(syncTimer);
    await new Promise<void>((resolve, reject) => {
        healthServer.close((error) => error ? reject(error) : resolve());
    });
    await prisma.$disconnect();
    writeEvent("bot.standby.stopped");
}

main().catch(async (error: unknown) => {
    logger.fatal({ err: error, event: "bot.standby.failed" }, "bot.standby.failed");
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
});
