import { beforeEach, describe, expect, it, vi } from "vitest";

const findActiveTicketByUser = vi.fn();
const findActiveOutgoingTopicByUser = vi.fn();
const updateTicket = vi.fn();
const touchTicket = vi.fn();
const findWithStaffProfileByTelegramId = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const outgoingTopicUpdate = vi.fn();
const recordDeclineReason = vi.fn().mockResolvedValue({ count: 1 });
const createTicket = vi.fn();

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

vi.mock("../../../../services/task-proof-service.js", () => ({
    taskProofService: {
        getSubmissionById: vi.fn(),
        findBySupportTopic: vi.fn(),
        findLatestWaitingForStaffByStaffId: vi.fn().mockResolvedValue(null),
        markWaitingForStaff: vi.fn(),
        markWaitingForSupport: vi.fn(),
        closeSupportTopic: vi.fn(),
    }
}));

vi.mock("../../../../repositories/pending-reply-repository.js", () => ({
    pendingReplyRepository: { recordDeclineReason },
}));
vi.mock("../../../../services/support-service.js", () => ({ supportService: { createTicket } }));

describe("broadcast decline reason", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findWithStaffProfileByTelegramId.mockResolvedValue({
            id: "user-1",
            staffProfile: { isActive: true, fullName: "Гут Ольга", location: null },
        });
        createTicket.mockRejectedValue(new Error("stop here"));
    });

    it("saves the reason text into PendingReply.declineReason", async () => {
        const { handleStaffMessage } = await import("../support.js");
        const ctx = {
            chat: { id: 385856787, type: "private" },
            from: { id: 385856787, username: "gut" },
            me: { id: 222 },
            update: { update_id: 1 },
            session: { step: "broadcast_decline_reason", broadcastId: 42 },
            message: { message_id: 11, text: "Не можу в цей день" },
            api: {},
            reply: vi.fn(),
        } as any;

        await handleStaffMessage(ctx, {} as any).catch(() => undefined);

        expect(recordDeclineReason).toHaveBeenCalledWith(385856787n, 42, "Не можу в цей день");
    });
});
