import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Рядок про зйомку в обробнику повідомлень фотографа (план 4, Task 15): новий тікет
 * отримує префікс, відкрита розмова — окреме повідомлення, а вхід через staff_help
 * і скидання після збою рядок стирають.
 */

const findActiveTicketByUser = vi.fn();
const findActiveOutgoingTopicByUser = vi.fn();
const updateTicket = vi.fn();
const touchTicket = vi.fn();
const findWithStaffProfileByTelegramId = vi.fn();
const findByTelegramId = vi.fn();
const findStaffByUserId = vi.fn();
const createTicket = vi.fn();
const closeTicket = vi.fn();
const getTaskById = vi.fn();
const renderScreen = vi.fn();
const loggerError = vi.fn();
const loggerWarn = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "staff-deactivated-shield": "deactivated",
        "support-ans-already-processing": "Твій запит вже обробляється!",
        "support-info-already-open": "<b>Твій діалог вже відкритий.</b>",
        "support-ask-issue": "<b>Напиши своє питання.</b>",
        "support-info-ticket-created": "created",
        "support-info-clarification-sent": "clarification",
        "staff-btn-home": "Меню",
        "hr-btn-cancel": "Скасувати",
        "shoot-task-support-prefix": (p: { line: string }) => `❓ <b>Питання по зйомці:</b>\n${p.line}`,
        "shoot-task-support-open-topic": (p: { line: string }) => `❓ From a shoot reminder: ${p.line}`,
    },
}));

vi.mock("../../../../core/logger.js", () => ({
    default: { info: vi.fn(), error: loggerError, debug: vi.fn(), trace: vi.fn(), warn: loggerWarn },
}));

vi.mock("../../../../config.js", () => ({
    SUPPORT_THREADS_ENABLED: false,
    RECOVERY_CHAT_ID: -1003873088973,
    SUPPORT_CHAT_ID: 999,
    TEAM_CHATS: { SUPPORT: 999, RECOVERY: -1003873088973 },
}));

vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: { findById: vi.fn(), findByTelegramId, findWithStaffProfileByTelegramId },
}));

vi.mock("../../../../repositories/support-repository.js", () => ({
    supportRepository: {
        findActiveTicketByUser,
        findActiveOutgoingTopicByUser,
        updateTicket,
        touchTicket,
        findTicketById: vi.fn(),
        findTicketByTopicId: vi.fn(),
        findOutgoingTopicByTopicId: vi.fn(),
    },
}));

vi.mock("../../../../repositories/staff-repository.js", () => ({ staffRepository: { findByUserId: findStaffByUserId } }));
vi.mock("../../../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));
vi.mock("../../../../services/stats-service.js", () => ({ statsService: {} }));
vi.mock("../../../../db/core.js", () => ({ default: { outgoingTopic: { update: vi.fn().mockResolvedValue({}) } } }));
vi.mock("../../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: { findClosestShiftWithLocation: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../../../../handlers/support-utils.js", () => ({
    updateTicketVisuals: vi.fn(),
    sendSupportStatus: vi.fn(),
    finalizeTopicUIClosure: vi.fn(),
}));
vi.mock("../../../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    htmlToPlainText: (value: string) => value,
}));
vi.mock("../../../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen } }));
vi.mock("../../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../../core/log-events.js", () => ({ logAuditEvent: vi.fn(), logBusinessEvent: vi.fn() }));
vi.mock("../../../../config/roles.js", () => ({ getAdminRoleByTelegramId: vi.fn() }));
vi.mock("../../../../middleware/role-check.js", () => ({ getUserAdminRole: vi.fn().mockResolvedValue(null) }));
vi.mock("../../../../services/task-proof-service.js", () => ({
    taskProofService: {
        getSubmissionById: vi.fn(),
        findBySupportTopic: vi.fn(),
        findLatestWaitingForStaffByStaffId: vi.fn().mockResolvedValue(null),
        markWaitingForStaff: vi.fn(),
        markWaitingForSupport: vi.fn(),
        closeSupportTopic: vi.fn(),
    },
}));
vi.mock("../../../../services/support-service.js", () => ({ supportService: { createTicket, closeTicket } }));
vi.mock("../../../../services/task-service.js", () => ({ taskService: { getTaskById } }));
vi.mock("../../../../repositories/timeline-repository.js", () => ({
    timelineRepository: { createEvent: vi.fn().mockResolvedValue({}) },
}));
vi.mock("../../../../utils/ticket-card.js", () => ({
    getLocationShortcut: () => "DP1",
    buildTopicTitle: () => "#1 · Гут",
    buildTicketCard: vi.fn().mockResolvedValue("card"),
    getTicketButtons: () => ({ inline_keyboard: [] }),
}));

const LINE = "Зйомка · <Олена> · сб 11.10";
const ESCAPED = "Зйомка · &lt;Олена&gt; · сб 11.10";
const USER_ID = "cmlqcnojh000sla5frjx4hced";
const pending = () => ({ line: LINE, at: Date.now() });

function staffMessageCtx(session: Record<string, unknown>, text = "Можна до п’ятниці?") {
    return {
        chat: { id: 385856787, type: "private" },
        from: { id: 385856787, username: "gut" },
        me: { id: 222 },
        update: { update_id: 267420318 },
        session: { step: "idle", ...session },
        message: { message_id: 11, text },
        api: {
            copyMessage: vi.fn().mockResolvedValue({ message_id: 12 }),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 13 }),
            forwardMessage: vi.fn().mockResolvedValue({}),
            createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 31000 }),
        },
        reply: vi.fn(),
    } as any;
}

describe("shoot support line in staff messages", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findWithStaffProfileByTelegramId.mockResolvedValue({
            id: USER_ID,
            staffProfile: { id: "staff-1", isActive: true, fullName: "Гут Ольга Богданівна", location: null },
        });
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(null);
        createTicket.mockResolvedValue({ id: 901, status: "OPEN" });
        updateTicket.mockResolvedValue({});
        touchTicket.mockResolvedValue({});
    });

    it("prefixes the new ticket with the escaped line and drops it from the session", async () => {
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ step: "create_ticket", shootSupportLine: pending() });

        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(createTicket).toHaveBeenCalledWith(
            USER_ID,
            `❓ <b>Питання по зйомці:</b>\n${ESCAPED}\n\n<b>Питання:</b> Можна до п’ятниці?`,
        );
        expect("shootSupportLine" in ctx.session).toBe(false);
        expect(ctx.session.step).toBe("idle");
    });

    it("a ticket without a line stays as it was", async () => {
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ step: "create_ticket" });

        await handleStaffMessage(ctx, {} as any);

        expect(createTicket).toHaveBeenCalledWith(USER_ID, "Можна до п’ятниці?");
    });

    it("drops the line when ticket creation fails before it was used", async () => {
        getTaskById.mockRejectedValue(new Error("db down"));
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ step: "create_ticket", clarificationTaskId: "task-1", shootSupportLine: pending() });

        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(createTicket).not.toHaveBeenCalled();
        expect("shootSupportLine" in ctx.session).toBe(false);
        expect("clarificationTaskId" in ctx.session).toBe(false);
    });

    it("drops the line on the handler-wide error reset", async () => {
        findWithStaffProfileByTelegramId.mockRejectedValue(new Error("db down"));
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ step: "create_ticket", shootSupportLine: pending() });
        ctx.reply.mockResolvedValue({});

        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(ctx.session.step).toBe("idle");
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("a line left for the open conversation goes into its topic before the message", async () => {
        findActiveTicketByUser.mockResolvedValue({ id: 454, topicId: 17030, status: "OPEN" });
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ shootSupportLine: pending() });

        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(ctx.api.sendMessage).toHaveBeenCalledWith(
            999,
            `❓ From a shoot reminder: ${ESCAPED}`,
            { message_thread_id: 17030, parse_mode: "HTML" },
        );
        expect(ctx.api.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(ctx.api.copyMessage.mock.invocationCallOrder[0]);
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("a ticket step overridden by an admin-opened topic still delivers the line there", async () => {
        findActiveOutgoingTopicByUser.mockResolvedValue({ id: 4, topicId: 4100 });
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ step: "create_ticket", shootSupportLine: pending() });

        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(createTicket).not.toHaveBeenCalled();
        expect(ctx.api.sendMessage).toHaveBeenCalledWith(999, expect.stringContaining(ESCAPED), {
            message_thread_id: 4100,
            parse_mode: "HTML",
        });
        expect(ctx.api.copyMessage).toHaveBeenCalled();
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("a refused line post does not lose the photographer's message and waits for the next one", async () => {
        findActiveTicketByUser.mockResolvedValue({ id: 454, topicId: 17030, status: "OPEN" });
        const { handleStaffMessage } = await import("../support.js");
        const at = Date.now() - 60_000;
        const ctx = staffMessageCtx({ shootSupportLine: { line: LINE, at } });
        ctx.api.sendMessage.mockRejectedValueOnce(Object.assign(new Error("Too Many Requests: retry after 3"), {
            payload: { text: `❓ From a shoot reminder: ${ESCAPED}` },
        }));

        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(ctx.api.copyMessage).toHaveBeenCalledWith(999, 385856787, 11, { message_thread_id: 17030 });
        expect(updateTicket).not.toHaveBeenCalledWith(454, { topicId: null });
        expect(ctx.session.shootSupportLine).toEqual({ line: LINE, at });
        const logged = JSON.stringify([...loggerError.mock.calls, ...loggerWarn.mock.calls]);
        expect(logged).not.toContain("Олена");
        expect(logged).toContain("errorName");
        expect(logged).not.toContain("Support topic forwarding failed");
    });
});

describe("a pending line older than 30 minutes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.UTC(2030, 2, 10, 9, 0)));
        findWithStaffProfileByTelegramId.mockResolvedValue({
            id: USER_ID,
            staffProfile: { id: "staff-1", isActive: true, fullName: "Гут Ольга Богданівна", location: null },
        });
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(null);
        createTicket.mockResolvedValue({ id: 902, status: "OPEN" });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("is never posted into a later, unrelated topic", async () => {
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ shootSupportLine: pending() });

        vi.advanceTimersByTime(31 * 60_000);
        findActiveOutgoingTopicByUser.mockResolvedValue({ id: 5, topicId: 5200 });
        expect(await handleStaffMessage(ctx, {} as any)).toBe(true);

        expect(ctx.api.copyMessage).toHaveBeenCalled();
        expect(ctx.api.sendMessage).not.toHaveBeenCalledWith(999, expect.stringContaining("Олена"), expect.anything());
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("does not prefix a ticket written later", async () => {
        const { handleStaffMessage } = await import("../support.js");
        const ctx = staffMessageCtx({ step: "create_ticket", shootSupportLine: pending() });

        vi.advanceTimersByTime(31 * 60_000);
        await handleStaffMessage(ctx, {} as any);

        expect(createTicket).toHaveBeenCalledWith(USER_ID, "Можна до п’ятниці?");
        expect("shootSupportLine" in ctx.session).toBe(false);
    });
});

describe("staff_help entry", () => {
    function helpCtx(session: Record<string, unknown>) {
        return {
            chat: { id: 385856787, type: "private" },
            from: { id: 385856787 },
            update: { update_id: 5, callback_query: { id: "q", data: "staff_help" } },
            callbackQuery: { id: "q", data: "staff_help" },
            session: { step: "idle", ...session },
            answerCallbackQuery: vi.fn().mockResolvedValue(true),
            has(filter: string) {
                return filter === "callback_query:data";
            },
        } as any;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        findByTelegramId.mockResolvedValue({ id: USER_ID });
        findStaffByUserId.mockResolvedValue({ id: "staff-1", isActive: true });
        findActiveTicketByUser.mockResolvedValue(null);
        findActiveOutgoingTopicByUser.mockResolvedValue(null);
    });

    it("starts a ticket without the stale shoot line", async () => {
        const { staffSupportHandlers } = await import("../support.js");
        const ctx = helpCtx({ shootSupportLine: pending() });

        await staffSupportHandlers.middleware()(ctx, async () => { });

        expect(ctx.session.step).toBe("create_ticket");
        expect("shootSupportLine" in ctx.session).toBe(false);
    });

    it("drops the stale line even when a ticket is already open", async () => {
        findActiveTicketByUser.mockResolvedValue({ id: 454, topicId: 17030, status: "OPEN" });
        const { staffSupportHandlers } = await import("../support.js");
        const ctx = helpCtx({ shootSupportLine: pending() });

        await staffSupportHandlers.middleware()(ctx, async () => { });

        expect(renderScreen).toHaveBeenCalled();
        expect("shootSupportLine" in ctx.session).toBe(false);
    });
});
