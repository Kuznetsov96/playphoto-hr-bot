import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByUserId, findById } = vi.hoisted(() => ({
    findByUserId: vi.fn(),
    findById: vi.fn(),
}));

vi.mock("../../../repositories/staff-repository.js", () => ({
    staffRepository: { findByUserId, findById },
}));

vi.mock("../../../utils/screen-manager.js", () => ({
    ScreenManager: { renderScreen: vi.fn() },
}));

import { startTaskFlow } from "../task-flow.js";
import type { MyContext } from "../../../types/context.js";

function makeCtx() {
    return {
        session: {},
        reply: vi.fn(),
    } as unknown as MyContext;
}

describe("startTaskFlow — carries the telegram id forward instead of discarding it", () => {
    beforeEach(() => {
        findByUserId.mockReset();
        findById.mockReset();
    });

    it("stores staff.user.telegramId (as a string) in taskData at step 0", async () => {
        findByUserId.mockResolvedValue({
            id: "staff-1",
            fullName: "Alice",
            location: { city: "Kyiv", name: "Obolon" },
            user: { telegramId: BigInt(123456789) },
        });
        const ctx = makeCtx();

        await startTaskFlow(ctx, "user-1");

        expect(ctx.session.taskData?.staffTelegramId).toBe("123456789");
    });

    it("stores null when the staff member has no linked Telegram user", async () => {
        findByUserId.mockResolvedValue({
            id: "staff-1",
            fullName: "Alice",
            location: null,
            user: null,
        });
        const ctx = makeCtx();

        await startTaskFlow(ctx, "user-1");

        expect(ctx.session.taskData?.staffTelegramId).toBeNull();
    });

    it("falls back to findById and still carries the telegram id when found by StaffProfile.id", async () => {
        findByUserId.mockResolvedValue(null);
        findById.mockResolvedValue({
            id: "staff-2",
            fullName: "Bob",
            location: null,
            user: { telegramId: BigInt(999) },
        });
        const ctx = makeCtx();

        await startTaskFlow(ctx, "staff-2");

        expect(ctx.session.taskData?.staffTelegramId).toBe("999");
    });
});

describe("task-flow.ts — no redundant user lookup at save time", () => {
    function read(relativePath: string): string {
        const path = fileURLToPath(new URL(relativePath, import.meta.url));
        return readFileSync(path, "utf8");
    }

    it("never imports userRepository — the telegram id fetched in startTaskFlow is reused instead of re-fetched at task_confirm_save", () => {
        const source = read("../task-flow.ts");
        expect(source).not.toContain("userRepository");
        expect(source).not.toContain("findByStaffProfileId");
    });
});
