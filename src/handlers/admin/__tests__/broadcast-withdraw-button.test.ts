import { describe, expect, it, vi } from "vitest";

vi.mock("../../../services/broadcast.js", () => ({ broadcastService: {} }));
vi.mock("../../../repositories/location-repository.js", () => ({ locationRepository: {} }));
vi.mock("../../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../utils/screen-manager.js", () => ({ ScreenManager: {} }));

const { canWithdraw } = await import("../broadcast.js");

describe("Withdraw button", () => {
    it("is offered for a live broadcast and hidden once withdrawn", () => {
        expect(canWithdraw({ withdrawnAt: null })).toBe(true);
        expect(canWithdraw({ withdrawnAt: new Date() })).toBe(false);
    });
});
