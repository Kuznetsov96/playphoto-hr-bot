import { beforeEach, describe, expect, it, vi } from "vitest";

const findWithStaffProfileByTelegramId = vi.fn();
const getDraft = vi.fn();
const getActiveDraftByStaffId = vi.fn();
const appendItem = vi.fn();
const mapTelegramMessageToTaskProofInput = vi.fn();

vi.mock("../../../../constants/staff-texts.js", () => ({
    STAFF_TEXTS: {},
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
        renderScreen: vi.fn(),
    },
}));

vi.mock("../../../../handlers/admin/utils.js", () => ({
    escapeHtml: (value: string) => value,
}));

vi.mock("../../../../utils/signed-callback.js", () => ({
    buildSignedCallback: vi.fn((code: string, id: string) => `${code}:${id}`),
}));

vi.mock("../../../../services/first-shift-onboarding-service.js", () => ({
    firstShiftOnboardingService: {},
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
});
