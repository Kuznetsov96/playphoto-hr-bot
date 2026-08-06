export interface ShadowConfig {
    databaseUrl: string;
    expectedDatabase: string;
    healthIntervalMs: number;
}

const MIN_HEALTH_INTERVAL_MS = 10_000;

export function readShadowConfig(env: NodeJS.ProcessEnv): ShadowConfig {
    if (env.BOT_STARTUP_MODE !== "shadow") {
        throw new Error("BOT_STARTUP_MODE must be exactly 'shadow'");
    }

    const databaseUrl = env.DATABASE_URL?.trim();
    if (!databaseUrl) {
        throw new Error("DATABASE_URL is required in shadow mode");
    }

    const expectedDatabase = env.SHADOW_EXPECTED_DATABASE?.trim() || "playphoto_bot";
    const rawHealthInterval = env.SHADOW_HEALTH_INTERVAL_MS?.trim() || "60000";
    const healthIntervalMs = Number(rawHealthInterval);

    if (!Number.isSafeInteger(healthIntervalMs) || healthIntervalMs < MIN_HEALTH_INTERVAL_MS) {
        throw new Error(`SHADOW_HEALTH_INTERVAL_MS must be an integer >= ${MIN_HEALTH_INTERVAL_MS}`);
    }

    return {
        databaseUrl,
        expectedDatabase,
        healthIntervalMs,
    };
}

