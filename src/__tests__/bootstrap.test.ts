import { describe, it, expect, vi, beforeEach } from "vitest";
import { Bot } from "grammy";

// Mock essential dependencies to avoid real network/db calls during bootstrap
vi.mock("../core/logger.js", () => ({
    default: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
    }
}));

vi.mock("../db/core.js", () => ({
    default: {
        $connect: vi.fn(),
        $disconnect: vi.fn(),
    }
}));

vi.mock("../core/redis.js", () => ({
    redis: {
        on: vi.fn(),
        ping: vi.fn().mockResolvedValue("PONG"),
    }
}));

describe("Bot Bootstrap & Menu Integrity", () => {
    it("should register Admin menus without duplicate errors", async () => {
        const { bot } = await import("../core/bot.js");
        const { registerAdminMenusHierarchy } = await import("../handlers/admin/bootstrap.js");

        // The test passes if this call doesn't throw "Menu 'id' already registered"
        await expect(registerAdminMenusHierarchy(bot)).resolves.not.toThrow();
    });

    it("should load HR menus without errors", async () => {
        const { hrHubMenu } = await import("../menus/hr.js");
        expect(hrHubMenu).toBeDefined();
    });

    it("should load Mentor menus without errors", async (ctx) => {
        const { mentorRootMenu } = await import("../menus/mentor.js");
        expect(mentorRootMenu).toBeDefined();
    });

    it("should load Candidate menus without errors", async () => {
        const { candidateRootMenu } = await import("../menus/candidate.js");
        expect(candidateRootMenu).toBeDefined();
    });
});
