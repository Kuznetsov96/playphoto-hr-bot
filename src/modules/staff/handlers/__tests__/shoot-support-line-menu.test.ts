import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Вхід у підтримку з кнопки нагадування про зйомку (план 4, Task 15): рядок або
 * чекає першого повідомлення (новий тікет), або одразу йде у відкриту тему.
 */

const findWithProfilesByTelegramId = vi.fn();
const findWithStaffProfileByTelegramId = vi.fn();
const resolveActiveSupportConversation = vi.fn();
const renderScreen = vi.fn();
const getTaskById = vi.fn();
const loggerError = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "support-ans-already-processing": "Твій запит вже обробляється!",
        "support-info-already-open": "<b>Твій діалог вже відкритий.</b>",
        "support-ask-issue": "<b>Напиши своє питання.</b>",
        "shoot-task-support-prefix": (p: { line: string }) => `❓ <b>Питання по зйомці:</b>\n${p.line}`,
        "shoot-task-support-open-topic": (p: { line: string }) => `❓ From a shoot reminder: ${p.line}`,
    },
}));

vi.mock("../../../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { info: vi.fn(), error: loggerError, debug: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../../core/log-events.js", () => ({ logAuditEvent: vi.fn(), logBusinessEvent: vi.fn() }));
vi.mock("../../../../config.js", () => ({ TEAM_CHATS: { SUPPORT: 999 }, SUPPORT_THREADS_ENABLED: false }));

vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: {
        findByTelegramId: vi.fn(),
        findWithStaffProfileByTelegramId,
        findWithProfilesByTelegramId,
    },
}));
vi.mock("../../../../repositories/work-shift-repository.js", () => ({ workShiftRepository: {} }));
vi.mock("../../../../repositories/support-repository.js", () => ({
    supportRepository: { findActiveTicketByUser: vi.fn(), findActiveOutgoingTopicByUser: vi.fn() },
}));
vi.mock("../../../../services/task-service.js", () => ({ taskService: { getTaskById } }));
vi.mock("../../../../services/task-proof-service.js", () => ({
    taskProofService: {},
    mapTelegramMessageToTaskProofInput: vi.fn(),
}));
vi.mock("../../../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen } }));
vi.mock("../../../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    htmlToPlainText: (value: string) => value,
}));
vi.mock("../../../../utils/signed-callback.js", () => ({
    buildSignedCallback: vi.fn((code: string, id: string) => `${code}:${id}`),
}));
vi.mock("../../../../services/first-shift-onboarding-service.js", () => ({
    firstShiftOnboardingService: { findActiveCaseByTelegramId: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../../../../services/support-conversation-service.js", () => ({
    supportConversationService: { resolveActive: resolveActiveSupportConversation },
}));
vi.mock("../../../../services/replacement-service.js", () => ({ replacementService: {} }));
vi.mock("../../../../utils/shift-time.js", () => ({ getShiftTimeFromLocationSchedule: vi.fn() }));

const LINE = "Зйомка · Олена · сб 11.10";

function makeCtx(session: Record<string, unknown> = {}) {
    return {
        chat: { id: 7261722607, type: "private" },
        from: { id: 7261722607 },
        update: { update_id: 1001, callback_query: { id: "q", data: "cb:sds:x" } },
        correlationId: "correlation-1",
        callbackQuery: { id: "q", data: "cb:sds:x", message: { message_id: 500 } },
        session: { step: "idle", navStack: [], messagesToDelete: [], candidateData: {}, ...session },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        reply: vi.fn().mockResolvedValue({ message_id: 501 }),
        editMessageText: vi.fn(),
        deleteMessage: vi.fn(),
        api: { deleteMessage: vi.fn(), sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }) },
    } as any;
}

function openTicket(topicId: number | null) {
    return { kind: "ticket", id: 857, topicId, ticket: { id: 857, topicId, status: "IN_PROGRESS" } };
}

describe("startSupportFlow with a shoot line", () => {
    beforeEach(() => {
        // Вікно дедупу живе в модулі — кожен тест із чистого модуля.
        vi.resetModules();
        vi.clearAllMocks();
        findWithProfilesByTelegramId.mockResolvedValue({
            id: "user-1",
            staffProfile: { id: "staff-1", isActive: true },
            candidate: { id: "candidate-1", status: "HIRED" },
        });
        resolveActiveSupportConversation.mockResolvedValue(null);
    });

    it("keeps the line for the new ticket", async () => {
        const { startSupportFlow } = await import("../menu.js");
        const ctx = makeCtx();

        await startSupportFlow(ctx, { shootLine: LINE });

        expect(ctx.session.step).toBe("create_ticket");
        expect(ctx.session.shootSupportLine).toEqual({ line: LINE, at: expect.any(Number) });
        expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    });

    it("drops a stale line when support is opened without one", async () => {
        const { startSupportFlow } = await import("../menu.js");
        const ctx = makeCtx({ shootSupportLine: LINE });

        await startSupportFlow(ctx);

        expect(ctx.session.step).toBe("create_ticket");
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("posts the line into the open topic and shows the usual already-open screen", async () => {
        resolveActiveSupportConversation.mockResolvedValue(openTicket(33298));
        const { startSupportFlow } = await import("../menu.js");
        const ctx = makeCtx();

        await startSupportFlow(ctx, { shootLine: LINE });

        expect(ctx.api.sendMessage).toHaveBeenCalledWith(
            999,
            `❓ From a shoot reminder: ${LINE}`,
            { message_thread_id: 33298, parse_mode: "HTML" },
        );
        expect("shootSupportLine" in ctx.session).toBe(false);
        expect(ctx.session.step).toBe("idle");
        expect(ctx.reply).toHaveBeenCalledWith("<b>Твій діалог вже відкритий.</b>", expect.objectContaining({ parse_mode: "HTML" }));
        expect(renderScreen).not.toHaveBeenCalled();
    });

    it("posts into an admin-opened (outgoing) topic too", async () => {
        resolveActiveSupportConversation.mockResolvedValue({
            kind: "outgoing",
            id: 4,
            topicId: 4100,
            outgoingTopic: { id: 4, topicId: 4100 },
        });
        const { startSupportFlow } = await import("../menu.js");
        const ctx = makeCtx();

        await startSupportFlow(ctx, { shootLine: LINE });

        expect(ctx.api.sendMessage).toHaveBeenCalledWith(999, expect.stringContaining(LINE), {
            message_thread_id: 4100,
            parse_mode: "HTML",
        });
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("keeps the line for the next message when the open ticket has no topic yet", async () => {
        resolveActiveSupportConversation.mockResolvedValue(openTicket(null));
        const { startSupportFlow } = await import("../menu.js");
        const ctx = makeCtx();

        await startSupportFlow(ctx, { shootLine: LINE });

        expect(ctx.api.sendMessage).not.toHaveBeenCalled();
        expect(ctx.session.shootSupportLine).toEqual({ line: LINE, at: expect.any(Number) });
        expect(ctx.reply).toHaveBeenCalledWith("<b>Твій діалог вже відкритий.</b>", expect.objectContaining({ parse_mode: "HTML" }));
        expect(renderScreen).not.toHaveBeenCalled();
    });

    it("keeps the line when Telegram refuses, and logs neither the line nor the error payload", async () => {
        resolveActiveSupportConversation.mockResolvedValue(openTicket(33298));
        const { startSupportFlow } = await import("../menu.js");
        const ctx = makeCtx();
        const refusal = Object.assign(new Error("Bad Request: message thread not found"), {
            payload: { text: `❓ From a shoot reminder: ${LINE}` },
        });
        ctx.api.sendMessage.mockRejectedValue(refusal);

        await startSupportFlow(ctx, { shootLine: LINE });

        expect(ctx.session.shootSupportLine).toEqual({ line: LINE, at: expect.any(Number) });
        expect(ctx.reply).toHaveBeenCalledWith("<b>Твій діалог вже відкритий.</b>", expect.objectContaining({ parse_mode: "HTML" }));
        expect(renderScreen).not.toHaveBeenCalled();
        expect(loggerError).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(loggerError.mock.calls[0]);
        expect(logged).not.toContain("Олена");
        expect(logged).toContain("errorName");
    });

    it("a double tap posts the line once", async () => {
        resolveActiveSupportConversation.mockResolvedValue(openTicket(33298));
        const { startSupportFlow } = await import("../menu.js");
        const first = makeCtx();
        const second = makeCtx();
        second.api = first.api;

        await startSupportFlow(first, { shootLine: LINE });
        await startSupportFlow(second, { shootLine: LINE });

        expect(first.api.sendMessage).toHaveBeenCalledTimes(1);
        expect("shootSupportLine" in second.session).toBe(false);
        expect(first.reply).toHaveBeenCalledTimes(1);
        expect(second.reply).toHaveBeenCalledTimes(1);
    });

    it("a tap after a refused send tries again", async () => {
        resolveActiveSupportConversation.mockResolvedValue(openTicket(33298));
        const { startSupportFlow } = await import("../menu.js");
        const first = makeCtx();
        first.api.sendMessage.mockRejectedValueOnce(new Error("Too Many Requests"));
        const second = makeCtx();
        second.api = first.api;

        await startSupportFlow(first, { shootLine: LINE });
        await startSupportFlow(second, { shootLine: LINE });

        expect(first.api.sendMessage).toHaveBeenCalledTimes(2);
        expect("shootSupportLine" in second.session).toBe(false);
    });
});

describe("leaving to the staff hub", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findWithStaffProfileByTelegramId.mockResolvedValue(null);
    });

    it("drops the pending line (cancel and «Меню» both lead here)", async () => {
        const { showStaffHub } = await import("../menu.js");
        const ctx = makeCtx({ step: "create_ticket", shootSupportLine: { line: LINE, at: Date.now() } });

        await showStaffHub(ctx);

        expect(ctx.session.step).toBe("idle");
        expect("shootSupportLine" in ctx.session).toBe(false);
    });
});

describe("task clarification entry", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getTaskById.mockResolvedValue({ id: "task-12345", taskText: "Протерти принтер" });
    });

    it("drops a stale shoot line so the clarification ticket carries one context only", async () => {
        const { staffHandlers } = await import("../menu.js");
        const ctx = makeCtx({ shootSupportLine: LINE });
        ctx.update.callback_query.data = "staff_task_help_task-12345";
        ctx.callbackQuery.data = "staff_task_help_task-12345";

        await staffHandlers.middleware()(ctx, async () => { });

        expect(ctx.session.step).toBe("create_ticket");
        expect(ctx.session.clarificationTaskId).toBe("task-12345");
        expect("shootSupportLine" in ctx.session).toBe(false);
    });
});
