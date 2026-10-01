import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowFor = vi.fn();
const scheduleFor = vi.fn();
const findStaff = vi.fn();

vi.mock("../../config.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    BUSINESS_DATA_SOURCE: "aws",
}));
vi.mock("../../services/aws-business-client.js", () => ({
    awsBusinessClient: {
        schedulePreferenceWindow: (...a: unknown[]) => windowFor(...a),
        schedulePreferenceSchedule: (...a: unknown[]) => scheduleFor(...a),
    },
}));
vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: { findWithStaffProfileByTelegramId: (...a: unknown[]) => findStaff(...a) },
}));

const { shouldShowPreferencesButton } = await import("../staff.js");

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    windowFor.mockReset();
    scheduleFor.mockReset();
    findStaff.mockReset().mockResolvedValue({ staffProfile: { awsEmployeePublicId: "emp-1" } });
});
afterEach(() => vi.useRealTimers());

// Сбор закрыт для всех, но владелец открыл окно одной фотографине («Reopen for …»):
// форма её пускала, а кнопки в меню не было — нажать было некуда.
describe("preferences button and a personal reopen", () => {
    it("shows the button to someone the owner reopened the window for", async () => {
        vi.setSystemTime(new Date("2031-09-27T10:00:00+03:00"));
        windowFor.mockResolvedValue({ month: "2031-10", open: false });
        scheduleFor.mockResolvedValue({ open: true });

        await expect(shouldShowPreferencesButton(111)).resolves.toBe(true);
        expect(scheduleFor).toHaveBeenCalledWith("2031-10", "emp-1");
    });

    it("keeps it hidden for everyone else once collection is closed", async () => {
        vi.setSystemTime(new Date("2032-09-27T10:00:00+03:00"));
        windowFor.mockResolvedValue({ month: "2032-10", open: false });
        scheduleFor.mockResolvedValue({ open: false });

        await expect(shouldShowPreferencesButton(222)).resolves.toBe(false);
    });

    it("does not ask per person while collection is open for all", async () => {
        vi.setSystemTime(new Date("2033-09-27T10:00:00+03:00"));
        windowFor.mockResolvedValue({ month: "2033-10", open: true });

        await expect(shouldShowPreferencesButton(333)).resolves.toBe(true);
        expect(scheduleFor).not.toHaveBeenCalled();
    });
});
