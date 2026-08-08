import { describe, expect, it } from "vitest";
import { readShadowConfig } from "../config.js";

describe("readShadowConfig", () => {
    it("requires an explicit shadow startup mode", () => {
        expect(() => readShadowConfig({
            DATABASE_URL: "postgresql://example.invalid/playphoto_bot",
        })).toThrow("BOT_STARTUP_MODE must be exactly 'shadow'");
    });

    it("requires a database URL", () => {
        expect(() => readShadowConfig({
            BOT_STARTUP_MODE: "shadow",
        })).toThrow("DATABASE_URL or DATABASE_SECRET_FILE is required in shadow mode");
    });

    it("builds a database URL from a mounted secret file", () => {
        const config = readShadowConfig({
            BOT_STARTUP_MODE: "shadow",
            DATABASE_SECRET_FILE: "/run/secrets/database.json",
        }, () => JSON.stringify({
            username: "shadow-user",
            password: "p@ss/word",
            host: "database.internal",
            port: 5432,
            dbname: "playphoto_bot",
        }));

        expect(config.databaseUrl).toBe(
            "postgresql://shadow-user:p%40ss%2Fword@database.internal:5432/playphoto_bot?sslmode=require",
        );
    });

    it("refuses ambiguous database credentials", () => {
        expect(() => readShadowConfig({
            BOT_STARTUP_MODE: "shadow",
            DATABASE_URL: "postgresql://example.invalid/playphoto_bot",
            DATABASE_SECRET_FILE: "/run/secrets/database.json",
        }, () => "{}")).toThrow("Set only one of DATABASE_URL or DATABASE_SECRET_FILE");
    });

    it("returns safe defaults", () => {
        expect(readShadowConfig({
            BOT_STARTUP_MODE: "shadow",
            DATABASE_URL: "postgresql://example.invalid/playphoto_bot",
        })).toEqual({
            databaseUrl: "postgresql://example.invalid/playphoto_bot",
            expectedDatabase: "playphoto_bot",
            healthIntervalMs: 60_000,
        });
    });

    it("rejects overly frequent health checks", () => {
        expect(() => readShadowConfig({
            BOT_STARTUP_MODE: "shadow",
            DATABASE_URL: "postgresql://example.invalid/playphoto_bot",
            SHADOW_HEALTH_INTERVAL_MS: "9999",
        })).toThrow("SHADOW_HEALTH_INTERVAL_MS must be an integer >= 10000");
    });
});
