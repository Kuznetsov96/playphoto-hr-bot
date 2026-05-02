import { beforeEach, describe, expect, it, vi } from "vitest";

const findTicketByTopicId = vi.fn();
const findOutgoingTopicByTopicId = vi.fn();
const getAdminRoleByTelegramId = vi.fn();
const loggerWarn = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {}
}));

vi.mock("../../../../core/logger.js", () => ({
    default: {
        info: vi.fn(),
        error: vi.fn(),
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

vi.mock("../../../../config/roles.js", () => ({
    getAdminRoleByTelegramId,
}));

vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: {
        findById: vi.fn(),
        findByTelegramId: vi.fn(),
    }
}));

vi.mock("../../../../repositories/support-repository.js", () => ({
    supportRepository: {
        findTicketByTopicId,
        findOutgoingTopicByTopicId,
        findActiveTicketByUser: vi.fn(),
        findActiveOutgoingTopicByUser: vi.fn(),
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
            update: vi.fn(),
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

vi.mock("../../../../services/task-proof-service.js", () => ({
    taskProofService: {
        getSubmissionById: vi.fn(),
        findBySupportTopic: vi.fn(),
        findLatestWaitingForStaffByStaffId: vi.fn(),
        markWaitingForStaff: vi.fn(),
        markWaitingForSupport: vi.fn(),
        closeSupportTopic: vi.fn(),
    }
}));

describe("support group impersonation guard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("blocks non-admin messages before any ticket lookup or forwarding", async () => {
        getAdminRoleByTelegramId.mockReturnValue(null);

        const { handleSupportGroupMessage } = await import("../support.js");

        const ctx = {
            chat: { id: 999 },
            message: {
                message_thread_id: 123,
                text: "forged admin reply"
            },
            from: {
                id: 111,
                first_name: "Eve"
            },
            me: { id: 222 }
        } as any;

        const handled = await handleSupportGroupMessage(ctx, {} as any);

        expect(handled).toBe(false);
        expect(getAdminRoleByTelegramId).toHaveBeenCalledWith(BigInt(111));
        expect(findTicketByTopicId).not.toHaveBeenCalled();
        expect(findOutgoingTopicByTopicId).not.toHaveBeenCalled();
        expect(loggerWarn).toHaveBeenCalled();
    });
});
