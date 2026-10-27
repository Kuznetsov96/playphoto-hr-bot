import { beforeEach, describe, expect, it, vi } from "vitest";

const renderScreen = vi.fn();
const goBack = vi.fn();

vi.mock("../../../services/broadcast.js", () => ({ broadcastService: {} }));
vi.mock("../../../services/aws-business-client.js", () => ({ awsBusinessClient: {} }));
vi.mock("../../../repositories/user-repository.js", () => ({ userRepository: {} }));
vi.mock("../../../middleware/role-check.js", () => ({ getUserAdminRole: vi.fn() }));
vi.mock("../../../core/logger.js", () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen, goBack } }));

const { adminBroadcastHandlers, adminBroadcastHubMenu } = await import("../broadcast.js");
const { ADMIN_TEXTS } = await import("../../../constants/admin-texts.js");

async function tap(data: string) {
    const ctx: any = {
        from: { id: 99 }, chat: { id: 99, type: "private" }, session: {},
        callbackQuery: { id: "q", data, message: { message_id: 5 } },
        update: { update_id: 1, callback_query: { id: "q", data } },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
    };
    let reachedNext = false;
    await adminBroadcastHandlers.middleware()(ctx, async () => { reachedNext = true; });
    return { ctx, reachedNext };
}

beforeEach(() => vi.clearAllMocks());

describe("announcements hub", () => {
    it("has only New announcement and Back", async () => {
        expect(adminBroadcastHubMenu).toBeDefined();
        const source = (await import("node:fs")).readFileSync(new URL("../broadcast.ts", import.meta.url), "utf8");
        const labels = [...source.matchAll(/range\.text\("([^"]+)"/g)].map(m => m[1]);
        expect(labels).toEqual(["New announcement", "Back"]);
    });

    it("title and button are emoji-free", () => {
        expect(ADMIN_TEXTS["admin-sys-broadcast"]).toBe("Announcements");
        expect(ADMIN_TEXTS["admin-sys-broadcast"]).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("Back to announcements returns to the hub with the shared title", async () => {
        const { ctx } = await tap("br_to_hub");
        expect(goBack).toHaveBeenCalledWith(ctx, "Announcements", "admin-broadcast-hub");
    });
});

describe("stale buttons from removed screens", () => {
    it.each([
        "br_withdraw_exec_17",
        "br_withdraw_cancel_17",
        "br_stop_all_pings_exec",
        "br_stop_all_pings_cancel",
        "br_back_to_main",
        "admin-broadcast-list/0,0/1",
        "admin-broadcast-archive/0,1/2",
        "admin-broadcast-manage/0,0/3",
        "br_type_ALL",
        "br_btn_none",
        "br_media_skip",
        "br_confirm_yes",
        "br_scope_city",
        "br_restart",
    ])("%s is answered quietly and does nothing", async (data) => {
        const { ctx, reachedNext } = await tap(data);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "This screen is no longer available." });
        expect(renderScreen).not.toHaveBeenCalled();
        expect(goBack).not.toHaveBeenCalled();
        expect(reachedNext).toBe(false);
    });
});
