import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserAdminRole = vi.fn();

vi.mock("../../../services/finance/dds.js", () => ({
    ddsService: {
        addTransaction: vi.fn(),
    },
}));

vi.mock("../../../middleware/role-check.js", () => ({
    getUserAdminRole,
}));

vi.mock("../../../repositories/location-repository.js", () => ({
    locationRepository: {
        findAllActive: vi.fn(),
    },
}));

vi.mock("../../../core/logger.js", () => ({
    default: {
        error: vi.fn(),
    },
}));

describe("admin finance expense flow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getUserAdminRole.mockResolvedValue("SUPPORT");
    });

    it("starts expense flow as an isolated admin flow", async () => {
        const { startExpenseFlow } = await import("../finance-expense.js");
        const ctx = {
            from: { id: 7416029746 },
            session: {
                step: "idle",
                adminFlow: "TASK",
                candidateData: {},
                taskData: { step: "AWAITING_TEXT", text: "old task" },
                taskCreation: { step: "TEXT" },
                broadcastData: { step: "AWAITING_CONTENT" },
                manualChannelAccess: { step: "AWAITING_GRANT_DETAILS" },
                supportData: { step: "AWAITING_REPLY", replyingToUserId: "919788835" },
            },
            reply: vi.fn(),
        } as any;

        await startExpenseFlow(ctx);

        expect(ctx.session.adminFlow).toBe("EXPENSE");
        expect(ctx.session.step).toBe("expense_amount");
        expect(ctx.session.candidateData).toEqual({ expenseFop: "Счёт ФОП Посредникова" });
        expect(ctx.session.taskData).toBeUndefined();
        expect(ctx.session.taskCreation).toBeUndefined();
        expect(ctx.session.broadcastData).toBeUndefined();
        expect(ctx.session.manualChannelAccess).toBeUndefined();
        expect(ctx.session.supportData.step).toBeUndefined();
        expect(ctx.session.supportData.replyingToUserId).toBeUndefined();
    });

    it("does not let expense location text fall through to another flow", async () => {
        const { handleExpenseText } = await import("../finance-expense.js");
        const next = vi.fn(async () => {});
        const ctx = {
            session: {
                adminFlow: "EXPENSE",
                step: "expense_location",
                candidateData: {
                    expenseFop: "Счёт ФОП Посредникова",
                    expenseAmount: 100,
                    expenseCategory: "Закупка расходников",
                },
                taskData: {
                    step: "AWAITING_TEXT",
                    staffId: "cmlqcnon80017la5focgmt67j",
                },
            },
            message: {
                text: "Рахунок IC за минулий місяць",
            },
            reply: vi.fn(),
        } as any;

        await handleExpenseText(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.reply).toHaveBeenCalledWith("📍 Please select a location/project using the buttons above.");
        expect(ctx.session.step).toBe("expense_location");
        expect(ctx.session.taskData.step).toBe("AWAITING_TEXT");
    });
});
