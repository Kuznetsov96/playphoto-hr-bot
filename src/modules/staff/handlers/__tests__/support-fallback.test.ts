import { beforeEach, describe, expect, it, vi } from "vitest";

const findActiveTicketByUser = vi.fn();
const findActiveOutgoingTopicByUser = vi.fn();
const updateTicket = vi.fn();
const touchTicket = vi.fn();
const findWithStaffProfileByTelegramId = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const outgoingTopicUpdate = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {
        "staff-deactivated-shield": "deactivated",
    }
}));

vi.mock("../../../../core/logger.js", () => ({
    default: {
        info: vi.fn(),
        error: loggerError,
        debug: vi.fn(),
        trace: vi.fn(),
        warn: loggerWarn,
    }
}));

vi.mock("../../../../config.js", () => ({
    RECOVERY_CHAT_ID: -1003873088973,
    SUPPORT_CHAT_ID: 999,
    TEAM_CHATS: {
        SUPPORT: 999,
        RECOVERY: -1003873088973,
    }
}));

vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: {
        findById: vi.fn(),
        findByTelegramId: vi.fn(),
        findWithStaffProfileByTelegramId,
    }
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
    }
}));

vi.mock("../../../../repositories/staff-repository.js", () => ({
    staffRepository: {
        findByUserId: vi.fn(),
    }
}));

vi.mock("../../../../repositories/candidate-repository.js", () => ({
    candidateRepository: {}
}));

vi.mock("../../../../services/stats-service.js", () => ({
    statsService: {}
}));

vi.mock("../../../../db/core.js", () => ({
    default: {
        outgoingTopic: {
            update: outgoingTopicUpdate,
        }
    }
}));

vi.mock("../../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: {}
}));

vi.mock("../../../../handlers/support-utils.js", () => ({
    updateTicketVisuals: vi.fn(),
    sendSupportStatus: vi.fn(),
    finalizeTopicUIClosure: vi.fn(),
}));

vi.mock("../../../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value,
}));

vi.mock("../../../../utils/screen-manager.js", () => ({
    ScreenManager: {
        renderScreen: vi.fn(),
    }
}));

vi.mock("../../../../core/audit-logger.js", () => ({
    audit: vi.fn(),
}));

vi.mock("../../../../core/log-events.js", () => ({
    logAuditEvent: vi.fn(),
    logBusinessEvent: vi.fn(),
}));

vi.mock("../../../../config/roles.js", () => ({
    getAdminRoleByTelegramId: vi.fn(),
}));

describe("staff support forwarding fallback", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findWithStaffProfileByTelegramId.mockResolvedValue({
            id: "cmlqcnojh000sla5frjx4hced",
            staffProfile: {
                isActive: true,
                fullName: "Гут Ольга Богданівна",
            }
        });
        findActiveTicketByUser.mockResolvedValue({
            id: 454,
            topicId: 17030,
            status: "OPEN",
        });
        findActiveOutgoingTopicByUser.mockResolvedValue(null);
    });

    it("falls back with a specific reason and manual content when Telegram blocks forwarding", async () => {
        const { handleStaffMessage } = await import("../support.js");

        const ctx = {
            chat: { id: 385856787, type: "private" },
            from: { id: 385856787, username: "gut" },
            me: { id: 222 },
            update: { update_id: 267420318 },
            session: { step: "idle" },
            message: {
                message_id: 11,
                sticker: {
                    file_id: "sticker-file-id",
                }
            },
            api: {
                copyMessage: vi.fn().mockRejectedValue(new Error("Call to 'copyMessage' failed! (400: Bad Request: the message can't be forwarded)")),
                sendMessage: vi.fn().mockResolvedValue({}),
                forwardMessage: vi.fn().mockResolvedValue({}),
            },
            reply: vi.fn(),
        } as any;

        const handled = await handleStaffMessage(ctx, {} as any);

        expect(handled).toBe(true);
        expect(updateTicket).not.toHaveBeenCalled();
        expect(ctx.api.forwardMessage).not.toHaveBeenCalled();
        expect(ctx.api.sendMessage).toHaveBeenNthCalledWith(
            1,
            999,
            expect.stringContaining("Telegram не дозволив переслати цей тип повідомлення"),
            { parse_mode: "HTML" }
        );
        expect(ctx.api.sendMessage).toHaveBeenNthCalledWith(
            2,
            999,
            expect.stringContaining("Тип: <b>стікер</b>"),
            { parse_mode: "HTML" }
        );
        expect(loggerError).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "cmlqcnojh000sla5frjx4hced",
                topicId: 17030,
                ticketId: 454,
                reason: "message_not_forwardable",
            }),
            "Support topic forwarding failed"
        );
    });
});
