import { beforeEach, describe, expect, it, vi } from "vitest";

const findWithProfilesByTelegramId = vi.fn();
const getSchedulePreference = vi.fn();
const renderScreen = vi.fn();

vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: { findWithProfilesByTelegramId: (...a: unknown[]) => findWithProfilesByTelegramId(...a) },
}));
vi.mock("../../services/aws-business-client.js", () => ({
    awsBusinessClient: { getSchedulePreference: (...a: unknown[]) => getSchedulePreference(...a) },
}));
vi.mock("../../utils/screen-manager.js", () => ({
    ScreenManager: { renderScreen: (...a: unknown[]) => renderScreen(...a) },
}));
vi.mock("../../services/preferences-service.js", () => ({
    preferencesService: { hasExistingPreference: vi.fn().mockResolvedValue(false), savePreference: vi.fn() },
}));
vi.mock("../../config.js", () => ({ AWS_PREFERENCES_CANONICAL_WRITE_ENABLED: true }));
vi.mock("../../core/redis.js", () => ({ redis: {} }));
vi.mock("../../repositories/pending-reply-repository.js", () => ({ pendingReplyRepository: {} }));
vi.mock("../../services/canonical-preferences-writer.js", () => ({ saveCanonicalPreference: vi.fn() }));

const { startPreferencesFlow } = await import("../preferences-flow.js");

function lastRender() {
    const call = renderScreen.mock.calls.at(-1)!;
    return { text: call[1] as string, kb: call[2] as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined };
}

function selectableDays(): number[] {
    return (lastRender().kb?.inline_keyboard ?? [])
        .flat()
        .map((b) => /^pref_toggle_(\d+)$/.exec(b.callback_data ?? "")?.[1])
        .filter((d): d is string => d !== undefined)
        .map(Number);
}

describe("someone whose last day falls before the target month", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        // 23 серпня — день розсилки, календар цілиться у вересень.
        vi.setSystemTime(new Date("2026-08-23T09:00:00.000Z"));
        findWithProfilesByTelegramId.mockResolvedValue({
            staffProfile: { isActive: true, fullName: "Тест", awsEmployeePublicId: "emp-1" },
        });
        // Доопрацьовує до кінця серпня — у вересні вже не виходить.
        getSchedulePreference.mockResolvedValue({ exists: false, worksUntil: "2026-08-31" });
    });

    const ctx = () => ({ from: { id: 12345 }, session: {} as Record<string, unknown>, reply: vi.fn() }) as never;

    it("never writes a nonsense date like «0 вересня»", async () => {
        await startPreferencesFlow(ctx());

        expect(lastRender().text).not.toMatch(/\b0\s+вересня/u);
    });

    it("says the month needs nothing from them instead of showing a dead grid", async () => {
        // Людина отримала запрошення «познач свої вихідні», відкрила — і
        // побачила 30 глухих кнопок. Це читається як зламаний бот.
        await startPreferencesFlow(ctx());

        expect(lastRender().text).toMatch(/31 серпня/u);
        expect(selectableDays()).toEqual([]);
    });

    it("offers a way out rather than a grid nobody can use", async () => {
        await startPreferencesFlow(ctx());

        const buttons = (lastRender().kb?.inline_keyboard ?? []).flat();
        expect(buttons.length).toBeGreaterThan(0);
        expect(buttons.every((b) => b.callback_data === "none")).toBe(false);
    });
});
