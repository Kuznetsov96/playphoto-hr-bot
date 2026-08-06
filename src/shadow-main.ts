import * as dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { readShadowConfig } from "./shadow/config.js";

dotenv.config({ quiet: true });

interface DatabaseIdentityRow {
    database_name: string;
    transaction_read_only: string;
    table_count: bigint;
}

function writeEvent(event: string, details: Record<string, unknown> = {}) {
    console.log(JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        ...details,
    }));
}

async function main() {
    const config = readShadowConfig(process.env);
    const prisma = new PrismaClient({
        datasources: {
            db: {
                url: config.databaseUrl,
            },
        },
    });

    let resolveStop: (() => void) | undefined;
    const stopRequested = new Promise<void>((resolve) => {
        resolveStop = resolve;
    });
    let stopping = false;

    const requestStop = (signal: string, exitCode = 0) => {
        if (stopping) return;
        stopping = true;
        process.exitCode = exitCode;
        writeEvent("bot.shadow.stop_requested", { signal, exitCode });
        resolveStop?.();
    };

    process.once("SIGTERM", () => requestStop("SIGTERM"));
    process.once("SIGINT", () => requestStop("SIGINT"));

    await prisma.$connect();

    const identityRows = await prisma.$queryRawUnsafe<DatabaseIdentityRow[]>(`
        SELECT
            current_database() AS database_name,
            current_setting('transaction_read_only') AS transaction_read_only,
            (
                SELECT count(*)::bigint
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_type = 'BASE TABLE'
            ) AS table_count
    `);
    const identity = identityRows[0];

    if (!identity) {
        throw new Error("Shadow database identity query returned no rows");
    }
    if (identity.database_name !== config.expectedDatabase) {
        throw new Error(
            `Shadow mode expected database '${config.expectedDatabase}', got '${identity.database_name}'`,
        );
    }
    if (identity.transaction_read_only !== "on") {
        throw new Error("Shadow mode requires transaction_read_only=on");
    }

    writeEvent("bot.shadow.ready", {
        database: identity.database_name,
        readOnly: true,
        tableCount: Number(identity.table_count),
        telegramStarted: false,
        redisStarted: false,
        workersStarted: false,
        migrationsStarted: false,
    });

    const healthTimer = setInterval(() => {
        void prisma.$queryRawUnsafe("SELECT 1").catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Unknown database health-check failure";
            writeEvent("bot.shadow.database_unhealthy", { message });
            requestStop("DATABASE_HEALTH_FAILURE", 1);
        });
    }, config.healthIntervalMs);

    await stopRequested;
    clearInterval(healthTimer);
    await prisma.$disconnect();
    writeEvent("bot.shadow.stopped");
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown shadow startup failure";
    console.error(JSON.stringify({
        event: "bot.shadow.failed",
        timestamp: new Date().toISOString(),
        message,
    }));
    process.exit(1);
});

