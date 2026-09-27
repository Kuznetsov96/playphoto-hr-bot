import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineKeyboard } from "grammy";

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
vi.mock("../../core/logger.js", () => ({ default: logger }));

const { ScreenManager } = await import("../screen-manager.js");

function ctx() {
    return {
        chat: { id: 1 },
        from: { id: 1 },
        session: { step: "idle", navStack: [], messagesToDelete: [] },
        callbackQuery: { data: "staff_schedule", message: { message_id: 5 } },
        editMessageText: vi.fn().mockResolvedValue(true),
        reply: vi.fn().mockResolvedValue({ message_id: 6 }),
        api: { deleteMessage: vi.fn().mockResolvedValue(true) },
    } as any;
}

/**
 * Предупреждение «pushToStack ignored» стояло и на штатные экраны с обычной
 * клавиатурой — «Мій графік», выбор смены для підміни, экран новичка, — и
 * настоящая ошибка (экран вовсе без клавиатуры) терялась среди них.
 */
describe("ScreenManager pushToStack", () => {
    beforeEach(() => vi.clearAllMocks());

    it("does not warn for a screen with its own inline keyboard", async () => {
        await ScreenManager.renderScreen(ctx(), "Мій графік", new InlineKeyboard().text("🏠 Меню", "staff_hub_nav"), { pushToStack: true });

        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ callbackData: "staff_schedule" }),
            expect.stringContaining("pushToStack skipped"),
        );
    });

    it("warns, naming the button that led here, for a screen with no keyboard at all", async () => {
        await ScreenManager.renderScreen(ctx(), "Крок анкети", undefined, { pushToStack: true });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ callbackData: "staff_schedule" }),
            expect.stringContaining("pushToStack ignored"),
        );
    });

    it("still records a registered menu in the stack", async () => {
        const context = ctx();
        await ScreenManager.renderScreen(context, "Меню", new InlineKeyboard(), { pushToStack: true, manualMenuId: "staff-preferences" });

        expect(context.session.navStack.at(-1)?.menuId).toBe("staff-preferences");
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
