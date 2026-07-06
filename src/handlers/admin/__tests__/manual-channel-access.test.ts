import { beforeEach, describe, expect, it, vi } from "vitest";

const renderScreen = vi.fn();

vi.mock("../../../constants/admin-texts.js", () => ({
    ADMIN_TEXTS: new Proxy({
        "admin-channel-access-title": "Manual Channel Access",
        "admin-channel-access-prompt": "Send the person's Telegram ID.",
        "admin-channel-revoke-title": "Manual Channel Revoke",
        "admin-channel-revoke-prompt": "Send the person's Telegram ID.",
        "admin-btn-cancel": "Cancel",
    }, {
        get(target, prop: string) {
            return target[prop as keyof typeof target] || prop;
        },
    }),
}));

vi.mock("../../../core/logger.js", () => ({
    default: {
        error: vi.fn(),
    },
}));

vi.mock("../../../middleware/role-check.js", () => ({
    getUserAdminRole: vi.fn(),
}));

vi.mock("../../../repositories/user-repository.js", () => ({
    userRepository: {},
}));

vi.mock("../../../repositories/staff-repository.js", () => ({
    staffRepository: {},
}));

vi.mock("../../../services/access-service.js", () => ({
    accessService: {},
}));

vi.mock("../../../utils/screen-manager.js", () => ({
    ScreenManager: {
        renderScreen,
    },
}));

vi.mock("../utils.js", () => ({
    escapeHtml: (value: string) => value,
}));

describe("manual channel access flow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts as an isolated admin flow and clears stale broadcast state", async () => {
        const { startManualChannelAccessFlow } = await import("../manual-channel-access.js");
        const ctx = {
            session: {
                adminFlow: "BROADCAST",
                step: "expense_location",
                candidateData: { expenseAmount: 100 },
                broadcastData: { step: "AWAITING_CONTENT", text: "old broadcast" },
                broadcastDraft: { textHtml: "old broadcast" },
                taskData: { step: "AWAITING_TEXT" },
                taskCreation: { step: "TEXT" },
                supportData: { step: "AWAITING_REPLY", replyingToUserId: "919788835" },
            },
        } as any;

        await startManualChannelAccessFlow(ctx);

        expect(ctx.session.adminFlow).toBe("MANUAL_CHANNEL_ACCESS");
        expect(ctx.session.step).toBe("idle");
        expect(ctx.session.manualChannelAccess).toEqual({ step: "AWAITING_GRANT_DETAILS" });
        expect(ctx.session.broadcastData).toBeUndefined();
        expect(ctx.session.broadcastDraft).toBeUndefined();
        expect(ctx.session.taskData).toBeUndefined();
        expect(ctx.session.taskCreation).toBeUndefined();
        expect(ctx.session.supportData.step).toBeUndefined();
        expect(ctx.session.supportData.replyingToUserId).toBeUndefined();
        expect(renderScreen).toHaveBeenCalled();
    });
});
