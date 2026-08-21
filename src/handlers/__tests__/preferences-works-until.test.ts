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

/** Дні, які реально можна натиснути: решта віддає callback `none`. */
function selectableDays(): number[] {
    const kb = renderScreen.mock.calls.at(-1)![2] as { inline_keyboard: Array<Array<{ callback_data?: string }>> };
    return kb.inline_keyboard
        .flat()
        .map((b) => /^pref_toggle_(\d+)$/.exec(b.callback_data ?? "")?.[1])
        .filter((d): d is string => d !== undefined)
        .map(Number);
}

function messageText(): string {
    return renderScreen.mock.calls.at(-1)![1] as string;
}

describe("preferences calendar for someone working out their notice", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        // 23 серпня — день розсилки, календар цілиться у вересень.
        vi.setSystemTime(new Date("2026-08-23T09:00:00.000Z"));
        findWithProfilesByTelegramId.mockResolvedValue({
            staffProfile: { isActive: true, fullName: "Тест", awsEmployeePublicId: "emp-1" },
        });
    });

    function ctx() {
        return {
            from: { id: 12345 },
            session: {} as Record<string, unknown>,
            reply: vi.fn(),
        } as never;
    }

    it("offers only the days up to the last working one", async () => {
        getSchedulePreference.mockResolvedValue({ exists: false, worksUntil: "2026-09-05" });

        await startPreferencesFlow(ctx());

        expect(selectableDays()).toEqual([1, 2, 3, 4, 5]);
    });

    it("explains why the calendar is short", async () => {
        getSchedulePreference.mockResolvedValue({ exists: false, worksUntil: "2026-09-05" });

        await startPreferencesFlow(ctx());

        expect(messageText()).toContain("останній робочий день");
    });

    it("offers the whole month to someone staying on", async () => {
        getSchedulePreference.mockResolvedValue({ exists: false, worksUntil: null });

        await startPreferencesFlow(ctx());

        expect(selectableDays()).toHaveLength(30);
        expect(messageText()).not.toContain("останній робочий день");
    });

    it("keeps the full month when the backend read fails", async () => {
        // Недоступний бекенд не має мовчки ховати місяць від усіх.
        getSchedulePreference.mockRejectedValue(new Error("gateway down"));

        await startPreferencesFlow(ctx());

        expect(selectableDays()).toHaveLength(30);
    });
});
