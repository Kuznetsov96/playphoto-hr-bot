import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { Bot } from "grammy";

vi.mock("../../../core/logger.js", () => ({
    default: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), warn: vi.fn() },
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
}));
vi.mock("../../../db/core.js", () => ({ default: { $connect: vi.fn(), $disconnect: vi.fn() } }));
vi.mock("../../../core/redis.js", () => ({ redis: { on: vi.fn(), ping: vi.fn().mockResolvedValue("PONG") } }));

const findByTelegramId = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock("../../../repositories/user-repository.js", async (importOriginal) => {
    const actual: any = await importOriginal();
    return { ...actual, userRepository: { ...actual.userRepository, findByTelegramId, update } };
});

type Role = "SUPER_ADMIN" | "CO_FOUNDER" | "SUPPORT";

let bot: Bot<any>;
let adminMenu: any;
const menus: Record<string, any> = {};

async function labelsOf(menuId: string, role: Role, userId = 900_000_001): Promise<string[][]> {
    findByTelegramId.mockResolvedValue({ id: "u1", adminRole: role });
    let markup: any;
    const b = new Bot("123:abc", { botInfo: { id: 1, is_bot: true, first_name: "t", username: "t", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as any });
    b.api.config.use(async (_prev, _method, payload: any) => {
        markup = payload.reply_markup;
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: userId, type: "private" } } } as any;
    });
    const { registerAdminMenusHierarchy } = await import("../bootstrap.js");
    // Меню регистрируются один раз на процесс; для каждого прогона берём тот же корень.
    if (!bot) {
        bot = b;
        await registerAdminMenusHierarchy(b);
        adminMenu = (await import("../index.js")).adminMenu;
        for (const id of ["admin-main", "admin-system", "admin-team-ops"]) {
            menus[id] = (await import("../../../utils/menu-registry.js")).menuRegistry.get?.(id);
        }
    }
    b.use(adminMenu);
    b.use(async (ctx) => { await ctx.reply("x", { reply_markup: menus[menuId] ?? adminMenu }); });
    await b.handleUpdate({
        update_id: 1,
        message: { message_id: 1, date: 0, text: "/x", from: { id: userId, is_bot: false, first_name: "U" }, chat: { id: userId, type: "private" } },
    } as any);
    return (markup?.inline_keyboard ?? []).map((row: any[]) => row.map((btn) => btn.text));
}

beforeEach(() => { findByTelegramId.mockReset(); update.mockReset(); });

describe("admin menu tree", () => {
    it("SUPPORT main menu: Team, System and Logistics once, no Finance", async () => {
        const rows = await labelsOf("admin-main", "SUPPORT");
        const flat = rows.flat();
        expect(flat).toEqual(["Team", "System", "Logistics"]);
        expect(flat.filter((l) => l === "Logistics")).toHaveLength(1);
    });

    it("SUPER_ADMIN and CO_FOUNDER main menu: Team, Finance, System", async () => {
        for (const role of ["SUPER_ADMIN", "CO_FOUNDER"] as Role[]) {
            const flat = (await labelsOf("admin-main", role)).flat();
            expect(flat).toEqual(["Team", "Finance", "System"]);
        }
    });

    it("System has Announcements, Tasks and Back for everyone, no Count Magnets or Logistics", async () => {
        for (const role of ["SUPER_ADMIN", "CO_FOUNDER", "SUPPORT"] as Role[]) {
            const flat = (await labelsOf("admin-system", role)).flat();
            expect(flat).toEqual(["Announcements", "Tasks", "Back"]);
        }
    });

    it("Team has no Custom Sync or Channel", async () => {
        for (const role of ["SUPER_ADMIN", "CO_FOUNDER", "SUPPORT"] as Role[]) {
            const flat = (await labelsOf("admin-team-ops", role)).flat();
            expect(flat).not.toContain("Custom Sync");
            expect(flat).not.toContain("Channel");
            expect(flat.at(-1)).toBe("Back");
        }
        expect((await labelsOf("admin-team-ops", "SUPPORT")).flat()).toEqual(["Schedule", "Locations", "Staff Search", "Back"]);
        expect((await labelsOf("admin-team-ops", "SUPER_ADMIN")).flat()).toEqual(["Schedule", "Locations", "Staff Search", "Birthdays", "Back"]);
    });
});
