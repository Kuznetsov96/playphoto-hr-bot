import { readFileSync } from "node:fs";

export interface ShadowConfig {
    databaseUrl: string;
    expectedDatabase: string;
    healthIntervalMs: number;
}

const MIN_HEALTH_INTERVAL_MS = 10_000;

interface DatabaseSecret {
    username: string;
    password: string;
    host: string;
    port: number;
    dbname: string;
}

type SecretFileReader = (path: string) => string;

function databaseUrlFromSecret(secret: DatabaseSecret): string {
    const username = encodeURIComponent(secret.username);
    const password = encodeURIComponent(secret.password);
    const database = encodeURIComponent(secret.dbname);
    return `postgresql://${username}:${password}@${secret.host}:${secret.port}/${database}?sslmode=require`;
}

function readDatabaseSecret(path: string, readSecretFile: SecretFileReader): DatabaseSecret {
    const value = JSON.parse(readSecretFile(path)) as Partial<DatabaseSecret>;

    if (
        typeof value.username !== "string" || !value.username ||
        typeof value.password !== "string" || !value.password ||
        typeof value.host !== "string" || !value.host ||
        !Number.isSafeInteger(value.port) || Number(value.port) <= 0 ||
        typeof value.dbname !== "string" || !value.dbname
    ) {
        throw new Error("DATABASE_SECRET_FILE does not contain a valid database secret");
    }

    return value as DatabaseSecret;
}

export function readShadowConfig(
    env: NodeJS.ProcessEnv,
    readSecretFile: SecretFileReader = (path) => readFileSync(path, "utf8"),
): ShadowConfig {
    if (env.BOT_STARTUP_MODE !== "shadow") {
        throw new Error("BOT_STARTUP_MODE must be exactly 'shadow'");
    }

    const explicitDatabaseUrl = env.DATABASE_URL?.trim();
    const databaseSecretFile = env.DATABASE_SECRET_FILE?.trim();

    if (explicitDatabaseUrl && databaseSecretFile) {
        throw new Error("Set only one of DATABASE_URL or DATABASE_SECRET_FILE");
    }
    if (!explicitDatabaseUrl && !databaseSecretFile) {
        throw new Error("DATABASE_URL or DATABASE_SECRET_FILE is required in shadow mode");
    }

    const databaseUrl = explicitDatabaseUrl || databaseUrlFromSecret(
        readDatabaseSecret(databaseSecretFile!, readSecretFile),
    );

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
