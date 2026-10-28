import { describe, it, expect, vi, beforeEach } from "vitest";

const findByTelegramId = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: { findByTelegramId, update, create: vi.fn() },
}));

import { getCtxAdminRole } from "../role-check.js";

const ctxFor = (id: number | undefined) => ({ from: id ? { id } : undefined }) as any;

describe("getCtxAdminRole (per-update memo)", () => {
    beforeEach(() => {
        findByTelegramId.mockReset();
        update.mockReset();
    });

    it("reads the user once per update, however many times the menus ask", async () => {
        findByTelegramId.mockResolvedValue({ id: "u1", adminRole: "SUPPORT" });
        const ctx = ctxFor(900_000_001);

        const roles = await Promise.all([getCtxAdminRole(ctx), getCtxAdminRole(ctx), getCtxAdminRole(ctx)]);
        roles.push(await getCtxAdminRole(ctx));

        expect(roles).toEqual(["SUPPORT", "SUPPORT", "SUPPORT", "SUPPORT"]);
        expect(findByTelegramId).toHaveBeenCalledTimes(1);
    });

    it("does not carry the role over to the next update", async () => {
        findByTelegramId.mockResolvedValueOnce({ id: "u1", adminRole: "SUPPORT" });
        findByTelegramId.mockResolvedValueOnce({ id: "u1", adminRole: null });

        expect(await getCtxAdminRole(ctxFor(900_000_001))).toBe("SUPPORT");
        expect(await getCtxAdminRole(ctxFor(900_000_001))).toBeNull();
        expect(findByTelegramId).toHaveBeenCalledTimes(2);
    });

    it("does not remember a failed read", async () => {
        findByTelegramId.mockRejectedValueOnce(new Error("db down"));
        findByTelegramId.mockResolvedValueOnce({ id: "u1", adminRole: "CO_FOUNDER" });
        const ctx = ctxFor(900_000_001);

        await expect(getCtxAdminRole(ctx)).rejects.toThrow("db down");
        expect(await getCtxAdminRole(ctx)).toBe("CO_FOUNDER");
    });

    it("returns null without touching the database when the update has no sender", async () => {
        expect(await getCtxAdminRole(ctxFor(undefined))).toBeNull();
        expect(findByTelegramId).not.toHaveBeenCalled();
    });
});
