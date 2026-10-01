import { beforeEach, describe, expect, it, vi } from "vitest";

const findByTelegramId = vi.fn();
const update = vi.fn();
vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: {
        findByTelegramId: (...a: unknown[]) => findByTelegramId(...a),
        update: (...a: unknown[]) => update(...a),
    },
}));

const { getUserAdminRole } = await import("../role-check.js");

beforeEach(() => {
    findByTelegramId.mockReset();
    update.mockReset().mockResolvedValue({});
});

// Рішення власника 01.10.2026: наставника немає, роль і доступи прибрати.
// Роль лежала в базі — без цього вона пережила б зникнення з конфігу.
describe("MENTOR_LEAD after the mentor was removed", () => {
    it("clears the stored role and gives no admin access", async () => {
        findByTelegramId.mockResolvedValue({ id: "user-1", adminRole: "MENTOR_LEAD" });

        await expect(getUserAdminRole(999_000_111n)).resolves.toBeNull();
        expect(update).toHaveBeenCalledWith("user-1", { adminRole: null });
    });

    it("leaves other stored roles alone", async () => {
        findByTelegramId.mockResolvedValue({ id: "user-2", adminRole: "SUPPORT" });

        await expect(getUserAdminRole(999_000_222n)).resolves.toBe("SUPPORT");
        expect(update).not.toHaveBeenCalled();
    });
});
