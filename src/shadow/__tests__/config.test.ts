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
        })).toThrow("DATABASE_URL is required in shadow mode");
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

