import { beforeEach, describe, expect, it, vi } from "vitest";
import { Api, Context } from "grammy";

/**
 * /start link_<код>: настоящий обработчик команды и настоящий grammy `Context`,
 * замоканы границы — API вебаппа, база, экраны и сам Telegram.
 */

const completeTelegramLink = vi.fn();
const findWithProfilesByTelegramId = vi.fn();
const renderScreen = vi.fn();
const updateMany = vi.fn();
const logBusinessEvent = vi.fn();
const loggerCalls = vi.fn();

vi.mock("../../services/aws-business-client.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../services/aws-business-client.js")>()),
    awsBusinessClient: { completeTelegramLink },
}));
vi.mock("../../repositories/user-repository.js", () => ({ userRepository: { findWithProfilesByTelegramId } }));
vi.mock("../../db/core.js", () => ({ default: { user: { updateMany } } }));
vi.mock("../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen } }));
vi.mock("../../utils/cleanup.js", () => ({ cleanupMessages: vi.fn(), trackMessage: vi.fn() }));
vi.mock("../../middleware/role-check.js", () => ({
    requireRole: vi.fn(),
    getUserAdminRole: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../utils/command-manager.js", () => ({ updateUserCommands: vi.fn() }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent, logAuditEvent: vi.fn() }));
vi.mock("../../core/logger.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../core/logger.js")>()),
    default: { debug: loggerCalls, info: loggerCalls, warn: loggerCalls, error: loggerCalls, trace: loggerCalls },
}));
vi.mock("../../modules/staff/handlers/menu.js", () => ({ showStaffHub: vi.fn() }));
vi.mock("../../modules/candidate/handlers/index.js", () => ({
    candidateDataFromRecord: vi.fn(),
    startScreening: vi.fn(),
}));
vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: { findByTelegramId: vi.fn().mockResolvedValue(null) },
}));

const { commandHandlers } = await import("../commands.js");
const { AwsBusinessApiError } = await import("../../services/aws-business-client.js");
const { STAFF_TEXTS } = await import("../../constants/staff-texts.js");

type ApiCall = { method: string; payload: any };
let calls: ApiCall[] = [];
let session: any;
let updateId = 0;

const api = new Api("0:test");
api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    const result = method === "sendMessage"
        ? { message_id: 900 + calls.length, date: 0, chat: { id: 111, type: "private" }, text: "" }
        : true;
    return { ok: true, result } as any;
});
const me = { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any;
const from = { id: 111, is_bot: false, first_name: "Іра", last_name: "Коваль", username: "ira_k" };
const chat = { id: 111, type: "private" as const, first_name: "Іра" };

async function start(payload?: string) {
    const text = payload ? `/start ${payload}` : "/start";
    const ctx = new Context({
        update_id: ++updateId,
        message: {
            message_id: 70 + updateId, date: 0, chat, from, text,
            entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
    } as any, api, me) as any;
    ctx.session = session;
    await commandHandlers.middleware()(ctx, async () => { });
}

const replies = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
const CODE = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    session = { step: "idle", navStack: [], messagesToDelete: [] };
    findWithProfilesByTelegramId.mockResolvedValue(null);
    updateMany.mockResolvedValue({ count: 0 });
    completeTelegramLink.mockResolvedValue(undefined);
});

describe("/start link_<код>", () => {
    it("links the account and tells the person it is done", async () => {
        await start(`link_${CODE}`);
        expect(completeTelegramLink).toHaveBeenCalledWith(CODE, "111", "ira_k", "Іра", "Коваль");
        expect(replies()).toEqual([STAFF_TEXTS["telegram-link-success"]]);
        expect(updateMany).not.toHaveBeenCalled(); // обычный /start не запускался
    });

    it.each([404, 410])("says the link is stale on %i", async (status) => {
        completeTelegramLink.mockRejectedValue(new AwsBusinessApiError(status, "X", "x"));
        await start(`link_${CODE}`);
        expect(replies()).toEqual([STAFF_TEXTS["telegram-link-expired"]]);
    });

    it("says the Telegram is linked to another account on 409", async () => {
        completeTelegramLink.mockRejectedValue(new AwsBusinessApiError(409, "TELEGRAM_ALREADY_LINKED", "x"));
        await start(`link_${CODE}`);
        expect(replies()).toEqual([STAFF_TEXTS["telegram-link-already-linked"]]);
    });

    it.each([
        ["5xx", new AwsBusinessApiError(503, undefined, "down")],
        ["network", new TypeError("fetch failed")],
    ])("asks to retry on %s", async (_n, error) => {
        completeTelegramLink.mockRejectedValue(error);
        await start(`link_${CODE}`);
        expect(replies()).toEqual([STAFF_TEXTS["telegram-link-unavailable"]]);
    });

    it.each(["link_", "link_xyz", `link_${CODE}0`, `link_${CODE.toUpperCase()}`.slice(0, 20)])(
        "does not call the web app for malformed code %s",
        async (payload) => {
            await start(payload);
            expect(completeTelegramLink).not.toHaveBeenCalled();
            expect(replies()).toEqual([STAFF_TEXTS["telegram-link-expired"]]);
        },
    );

    it("never logs the code or the name", async () => {
        completeTelegramLink.mockRejectedValue(new AwsBusinessApiError(410, "LINK_CODE_EXPIRED", "x"));
        await start(`link_${CODE}`);
        const logged = JSON.stringify([...logBusinessEvent.mock.calls, ...loggerCalls.mock.calls]);
        expect(logged).not.toContain(CODE);
        expect(logged).not.toContain("Коваль");
        expect(logged).not.toContain("ira_k");
    });

    it("leaves a plain /start on its normal route", async () => {
        await start();
        expect(completeTelegramLink).not.toHaveBeenCalled();
        expect(updateMany).toHaveBeenCalled(); // сброс флага блокировки — часть обычного /start
        expect(replies()).not.toContain(STAFF_TEXTS["telegram-link-success"]);
    });
});
