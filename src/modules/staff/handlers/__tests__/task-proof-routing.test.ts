import { beforeEach, describe, expect, it, vi } from "vitest";

const findWithStaffProfileByTelegramId = vi.fn();
const findWithProfilesByTelegramId = vi.fn();
const findActiveCaseByTelegramId = vi.fn();
const resolveActiveSupportConversation = vi.fn();
const renderScreen = vi.fn();
const getDraft = vi.fn();
const getActiveDraftByStaffId = vi.fn();
const appendItem = vi.fn();
const mapTelegramMessageToTaskProofInput = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "support-ans-already-processing": "Твій запит вже обробляється!",
        "support-info-already-open": "<b>Твій діалог вже відкритий.</b>",
        "support-ask-issue": "<b>Напиши своє питання.</b>",
    },
}));

vi.mock("../../../../core/logger.js", () => ({
    REDACT_CONFIG: {
        paths: [],
        censor: "[PROTECTED]",
    },
    default: {
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock("../../../../core/audit-logger.js", () => ({
    audit: vi.fn(),
}));

vi.mock("../../../../core/log-events.js", () => ({
    logAuditEvent: vi.fn(),
    logBusinessEvent: vi.fn(),
}));

vi.mock("../../../../config.js", () => ({
    TEAM_CHATS: {
        SUPPORT: 999,
    },
}));

vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: {
        findByTelegramId: vi.fn(),
        findWithStaffProfileByTelegramId,
        findWithProfilesByTelegramId,
    },
}));

vi.mock("../../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: {},
}));

vi.mock("../../../../repositories/support-repository.js", () => ({
    supportRepository: {
        findActiveTicketByUser: vi.fn(),
        findActiveOutgoingTopicByUser: vi.fn(),
    },
}));

vi.mock("../../../../services/task-service.js", () => ({
    taskService: {},
}));

vi.mock("../../../../services/task-proof-service.js", () => ({
    taskProofService: {
        getDraft,
        getActiveDraftByStaffId,
        appendItem,
    },
    mapTelegramMessageToTaskProofInput,
}));

vi.mock("../../../../utils/screen-manager.js", () => ({
    ScreenManager: {
        renderScreen,
    },
}));

vi.mock("../../../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value,
    htmlToPlainText: (value: string) => value,
}));

vi.mock("../../../../utils/signed-callback.js", () => ({
    buildSignedCallback: vi.fn((code: string, id: string) => `${code}:${id}`),
}));

vi.mock("../../../../services/first-shift-onboarding-service.js", () => ({
    firstShiftOnboardingService: {
        findActiveCaseByTelegramId,
    },
}));

vi.mock("../../../../services/support-conversation-service.js", () => ({
    supportConversationService: {
        resolveActive: resolveActiveSupportConversation,
    },
}));

vi.mock("../../../../services/replacement-service.js", () => ({
    replacementService: {},
}));

vi.mock("../../../../utils/shift-time.js", () => ({
    getShiftTimeFromLocationSchedule: vi.fn(),
}));

describe("staff task proof message routing", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        findActiveCaseByTelegramId.mockResolvedValue(null);
    });

    it("does not intercept messages while staff is creating a support ticket", async () => {
        const { handleTaskProofMessage } = await import("../menu.js");

        const ctx = {
            chat: { id: 1164289764, type: "private" },
            from: { id: 1164289764 },
            session: { step: "create_ticket" },
            message: { message_id: 10, text: "Ooo" },
            reply: vi.fn(),
        } as any;

        const handled = await handleTaskProofMessage(ctx);

        expect(handled).toBe(false);
        expect(findWithStaffProfileByTelegramId).not.toHaveBeenCalled();
        expect(getActiveDraftByStaffId).not.toHaveBeenCalled();
        expect(appendItem).not.toHaveBeenCalled();
    });

    it("clears an explicit stale task proof step when no active draft exists", async () => {
        findWithStaffProfileByTelegramId.mockResolvedValue({
            staffProfile: {
                id: "staff-1",
            },
        });
        getDraft.mockResolvedValue(null);

        const { handleTaskProofMessage } = await import("../menu.js");

        const ctx = {
            chat: { id: 1164289764, type: "private" },
            from: { id: 1164289764 },
            session: {
                step: "awaiting_task_proof_task-1",
                taskProofFlow: { taskId: "task-1" },
            },
            message: { message_id: 11, text: "hello" },
            reply: vi.fn(),
        } as any;

        const handled = await handleTaskProofMessage(ctx);

        expect(handled).toBe(false);
        expect(getDraft).toHaveBeenCalledWith("task-1");
        expect(ctx.session.step).toBe("idle");
        expect(ctx.session.taskProofFlow).toBeUndefined();
        expect(mapTelegramMessageToTaskProofInput).not.toHaveBeenCalled();
        expect(appendItem).not.toHaveBeenCalled();
    });

    it.each(["staff_support_reply", "contact_hr"])(
        "keeps an admin message intact when staff opens its Reply button (%s)",
        async (callbackData) => {
            findWithProfilesByTelegramId.mockResolvedValue({
                id: "user-1",
                staffProfile: { id: "staff-1", isActive: true },
                candidate: { id: "candidate-1", status: "HIRED" },
            });
            resolveActiveSupportConversation.mockResolvedValue({
                kind: "ticket",
                id: 857,
                topicId: 33298,
                ticket: { id: 857, topicId: 33298, status: "IN_PROGRESS" },
            });

            const { startSupportFlow } = await import("../menu.js");
            const ctx = {
                chat: { id: 7261722607, type: "private" },
                from: { id: 7261722607 },
                update: { update_id: 1001 },
                correlationId: "correlation-1",
                callbackQuery: {
                    data: callbackData,
                    message: { message_id: 500 },
                },
                session: {
                    step: "idle",
                    navStack: [],
                    messagesToDelete: [],
                    candidateData: {},
                },
                answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
                reply: vi.fn().mockResolvedValue({ message_id: 501 }),
                editMessageText: vi.fn(),
                deleteMessage: vi.fn(),
                api: { deleteMessage: vi.fn() },
            } as any;

            await startSupportFlow(ctx);

            expect(resolveActiveSupportConversation).toHaveBeenCalledWith("user-1");
            expect(ctx.reply).toHaveBeenCalledWith(
                "<b>Твій діалог вже відкритий.</b>",
                expect.objectContaining({ parse_mode: "HTML" }),
            );
            expect(renderScreen).not.toHaveBeenCalled();
            expect(ctx.editMessageText).not.toHaveBeenCalled();
            expect(ctx.deleteMessage).not.toHaveBeenCalled();
            expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
        },
    );
});
