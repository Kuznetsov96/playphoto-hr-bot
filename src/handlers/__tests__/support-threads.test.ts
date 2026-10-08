import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn(async () => undefined);
const backToSupport = vi.fn(async () => true);
const relayEdit = vi.fn(async () => undefined);
const relayReaction = vi.fn(async () => undefined);
const getAdminRoleByTelegramId = vi.fn();

vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../config.js", () => ({ SUPPORT_THREADS_ENABLED: true, TEAM_CHATS: { SUPPORT: -1001234 } }));
vi.mock("../../config/roles.js", async () => {
    const actual = await vi.importActual<typeof import("../../config/roles.js")>("../../config/roles.js");
    return { ...actual, getAdminRoleByTelegramId };
});
vi.mock("../../services/support-thread-runtime.js", () => ({
    supportEscalationService: { call, backToSupport },
    supportRelayService: { relayEdit, relayReaction },
}));

const { supportThreadCallback, supportThreadEdit, supportThreadReaction } = await import("../support-threads.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function callbackCtx(data: string, fromId = 3) {
    return {
        callbackQuery: { data },
        from: { id: fromId, first_name: "Olena" },
        api: {},
        answerCallbackQuery: vi.fn(async () => true),
    } as Any;
}

beforeEach(() => {
    vi.clearAllMocks();
    getAdminRoleByTelegramId.mockReturnValue("SUPPORT");
});

describe("кнопки картки", () => {
    it("покликати Кузнєцова", async () => {
        const ctx = callbackCtx("sth:c:t1:k");
        await supportThreadCallback(ctx);
        expect(call).toHaveBeenCalledWith({}, "t1", "kuznetsov", { id: 3, firstName: "Olena" });
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Called. You can keep writing here.");
    });

    it("покликати Гупалову", async () => {
        await supportThreadCallback(callbackCtx("sth:c:t1:h"));
        expect(call).toHaveBeenCalledWith({}, "t1", "hupalova", expect.anything());
    });

    it("повернути в Support", async () => {
        const ctx = callbackCtx("sth:b:t1", 1);
        await supportThreadCallback(ctx);
        expect(backToSupport).toHaveBeenCalledWith({}, "t1", { id: 1, firstName: "Olena" });
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Handed back to Support.");
    });

    it("тема вже в Support — так і каже", async () => {
        backToSupport.mockResolvedValueOnce(false);
        const ctx = callbackCtx("sth:b:t1");
        await supportThreadCallback(ctx);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Already with Support.");
    });

    it("не підтримка — відмова, нічого не робить", async () => {
        getAdminRoleByTelegramId.mockReturnValue(null);
        const ctx = callbackCtx("sth:c:t1:k", 99);
        await supportThreadCallback(ctx);
        expect(call).not.toHaveBeenCalled();
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Support team only.", show_alert: true });
    });

    it("ціль не налаштована — пояснення", async () => {
        call.mockRejectedValueOnce(new Error("Escalation target kuznetsov is not configured"));
        const ctx = callbackCtx("sth:c:t1:k");
        await supportThreadCallback(ctx);
        expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "This person isn't set up in the bot config.", show_alert: true });
    });
});

describe("правки і реакції", () => {
    it("правка в приватному чаті — бік фотографині", async () => {
        const message = { message_id: 1, chat: { id: 555, type: "private" }, text: "x" };
        await supportThreadEdit({ editedMessage: message, chat: message.chat, api: {} } as Any);
        expect(relayEdit).toHaveBeenCalledWith({}, message, "staff");
    });

    it("правка в чаті підтримки — бік команди", async () => {
        const message = { message_id: 1, chat: { id: -1001234, type: "supergroup" }, text: "x" };
        await supportThreadEdit({ editedMessage: message, chat: message.chat, api: {} } as Any);
        expect(relayEdit).toHaveBeenCalledWith({}, message, "support");
    });

    it("правка в іншій групі — нічого", async () => {
        const message = { message_id: 1, chat: { id: -100999, type: "supergroup" }, text: "x" };
        await supportThreadEdit({ editedMessage: message, chat: message.chat, api: {} } as Any);
        expect(relayEdit).not.toHaveBeenCalled();
    });

    it("реакція в чаті підтримки — бік команди", async () => {
        const update = { chat: { id: -1001234, type: "supergroup" }, message_id: 5 };
        await supportThreadReaction({ messageReaction: update, api: {} } as Any);
        expect(relayReaction).toHaveBeenCalledWith({}, update, "support");
    });

    it("реакція в приватному — бік фотографині", async () => {
        const update = { chat: { id: 555, type: "private" }, message_id: 5 };
        await supportThreadReaction({ messageReaction: update, api: {} } as Any);
        expect(relayReaction).toHaveBeenCalledWith({}, update, "staff");
    });
});
