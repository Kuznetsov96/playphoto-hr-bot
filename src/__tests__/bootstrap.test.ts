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
    },
    REDACT_CONFIG: {
        paths: [],
        censor: "[PROTECTED]",
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
    // Importing the whole admin menu hierarchy is the heaviest thing the suite does — it pulls in
    // every handler transitively. It measured ~3.3s of vitest's 5s default, so any growth
    // elsewhere in the suite tipped it over and failed a test that was not about the change.
    // The timeout is generous on purpose: this test exists to catch duplicate menu ids, not to
    // police load time.
    it("should register Admin menus without duplicate errors", async () => {
        const { bot } = await import("../core/bot.js");
        const { registerAdminMenusHierarchy } = await import("../handlers/admin/bootstrap.js");

        // The test passes if this call doesn't throw "Menu 'id' already registered"
        await expect(registerAdminMenusHierarchy(bot)).resolves.not.toThrow();
    }, 30_000);

    it("should load HR menus without errors", async () => {
        // The recruiter's own HR hub (hrHubMenu) was removed 2026-09-03 — recruiting
        // now happens in the web app. What remains is the owner/admin "Final Step
        // Pipeline" flow, registered via the admin bootstrap.
        const { hrFinalStepMenu } = await import("../menus/hr.js");
        expect(hrFinalStepMenu).toBeDefined();
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
