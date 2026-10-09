import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Написати в підтримку» з нагадування про зйомку не має стирати саме нагадування:
 * у ньому телефон клієнта, ім'я дитини й побажання. ScreenManager тут СПРАВЖНІЙ —
 * саме він редагує повідомлення під кнопкою, і саме це й перевіряється.
 */

const findWithProfilesByTelegramId = vi.fn();
const resolveActiveSupportConversation = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "support-ans-already-processing": "Твій запит вже обробляється!",
        "support-info-already-open": "<b>Твій діалог вже відкритий.</b>",
        "support-ask-issue": "<b>Напиши своє питання.</b>",
        "shoot-task-support-open-topic": (p: { line: string }) => `❓ From a shoot reminder: ${p.line}`,
    },
}));
vi.mock("../../../../core/logger.js", () => ({
    REDACT_CONFIG: { paths: [], censor: "[PROTECTED]" },
    default: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../../../core/audit-logger.js", () => ({ audit: vi.fn() }));
vi.mock("../../../../core/log-events.js", () => ({ logAuditEvent: vi.fn(), logBusinessEvent: vi.fn() }));
vi.mock("../../../../config.js", () => ({ TEAM_CHATS: { SUPPORT: 999 }, SUPPORT_THREADS_ENABLED: false }));
vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: {
        findByTelegramId: vi.fn(),
        findWithStaffProfileByTelegramId: vi.fn(),
        findWithProfilesByTelegramId,
    },
}));
vi.mock("../../../../repositories/work-shift-repository.js", () => ({ workShiftRepository: {} }));
vi.mock("../../../../repositories/support-repository.js", () => ({
    supportRepository: { findActiveTicketByUser: vi.fn(), findActiveOutgoingTopicByUser: vi.fn() },
}));
vi.mock("../../../../services/task-service.js", () => ({ taskService: { getTaskById: vi.fn() } }));
vi.mock("../../../../services/task-proof-service.js", () => ({
    taskProofService: {},
    mapTelegramMessageToTaskProofInput: vi.fn(),
}));
vi.mock("../../../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value,
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

const REMINDER_ID = 500;
const CHAT_ID = 7261722607;

function tapOn(callbackData: string) {
    return {
        chat: { id: CHAT_ID, type: "private" },
        from: { id: CHAT_ID },
        update: { update_id: 1001, callback_query: { id: "q", data: callbackData } },
        correlationId: "correlation-1",
        callbackQuery: {
            id: "q",
            data: callbackData,
            message: { message_id: REMINDER_ID, text: "Зйомка · Олена · +380 67 000 00 00 · побажання" },
        },
        session: { step: "idle", navStack: [], messagesToDelete: [], candidateData: {} },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        reply: vi.fn().mockResolvedValue({ message_id: 501 }),
        editMessageText: vi.fn().mockResolvedValue(true),
        deleteMessage: vi.fn().mockResolvedValue(true),
        api: {
            deleteMessage: vi.fn().mockResolvedValue(true),
            sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
        },
    } as any;
}

function expectReminderUntouched(ctx: any) {
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
}

describe("support from a shoot reminder (real ScreenManager)", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        findWithProfilesByTelegramId.mockResolvedValue({
            id: "user-1",
            staffProfile: { id: "staff-1", isActive: true },
            candidate: { id: "candidate-1", status: "HIRED" },
        });
        resolveActiveSupportConversation.mockResolvedValue(null);
    });

    it("new ticket: the question prompt arrives as a new message, the reminder stays", async () => {
        const { startSupportFlow } = await import("../menu.js");
        const ctx = tapOn("cb:sds:shoot-task-1:0123456789");

        await startSupportFlow(ctx, { shootLine: "Зйомка · Олена · сб 11.10" });

        expectReminderUntouched(ctx);
        expect(ctx.reply).toHaveBeenCalledTimes(1);
        expect(ctx.reply).toHaveBeenCalledWith(
            "<b>Напиши своє питання.</b>",
            expect.objectContaining({ parse_mode: "HTML" }),
        );
        expect(ctx.session.step).toBe("create_ticket");
    });

    it("open dialog: the already-open notice arrives as a new message, the reminder stays", async () => {
        resolveActiveSupportConversation.mockResolvedValue({
            kind: "ticket",
            id: 857,
            topicId: 33298,
            ticket: { id: 857, topicId: 33298, status: "IN_PROGRESS" },
        });
        const { startSupportFlow } = await import("../menu.js");
        const ctx = tapOn("cb:sds:shoot-task-1:0123456789");

        await startSupportFlow(ctx, { shootLine: "Зйомка · Олена · сб 11.10" });

        expectReminderUntouched(ctx);
        expect(ctx.reply).toHaveBeenCalledWith(
            "<b>Твій діалог вже відкритий.</b>",
            expect.objectContaining({ parse_mode: "HTML" }),
        );
    });

    it.each(["staff_support_reply", "contact_hr"])("Reply on a person's message still keeps it (%s)", async (data) => {
        const { startSupportFlow } = await import("../menu.js");
        const ctx = tapOn(data);

        await startSupportFlow(ctx);

        expectReminderUntouched(ctx);
        expect(ctx.reply).toHaveBeenCalledTimes(1);
    });

    it("the menu's own support button still edits its screen in place", async () => {
        const { startSupportFlow } = await import("../menu.js");
        const ctx = tapOn("open_support_dialog");

        await startSupportFlow(ctx);

        expect(ctx.editMessageText).toHaveBeenCalledWith(
            "<b>Напиши своє питання.</b>",
            expect.objectContaining({ parse_mode: "HTML" }),
        );
        expect(ctx.reply).not.toHaveBeenCalled();
    });
});
