import { describe, expect, it, vi } from "vitest";

/**
 * Маршрутизація адмінського повідомлення: гілка підтримки чи напряму.
 *
 * Баг, який це закриває: штатному фотографу написали з адмінського меню,
 * повідомлення дійшло, а гілки в підтримці не з'явилося — і екран усе одно
 * показав «✅ Message sent and logged». Причина в тому, що найм створює
 * StaffProfile, але стару анкету не видаляє, і якщо та зупинилася на
 * онбординговому статусі, код вважав співробітника кандидатом на онбордингу.
 */

vi.mock("grammy", () => ({
    Composer: class { callbackQuery() { return this; } on() { return this; } },
    InlineKeyboard: class { text() { return this; } row() { return this; } url() { return this; } danger() { return this; } },
}));
vi.mock("../../../config.js", () => ({ SUPPORT_CHAT_ID: -1000000000001, ADMIN_IDS: [1] }));
vi.mock("../../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../../repositories/user-repository.js", () => ({ userRepository: {} }));
vi.mock("../../../repositories/staff-repository.js", () => ({ staffRepository: {} }));
vi.mock("../../../repositories/support-repository.js", () => ({ supportRepository: {} }));
vi.mock("../../../repositories/candidate-repository.js", () => ({ candidateRepository: {} }));
vi.mock("../../../modules/staff/services/index.js", () => ({ staffService: {} }));
vi.mock("../../../services/support-conversation-service.js", () => ({ supportConversationService: {} }));
vi.mock("../../../utils/screen-manager.js", () => ({ ScreenManager: { renderScreen: vi.fn() } }));

const { shouldUseDirectCandidateMessage } = await import("../search.js");

const ACTIVE_STAFF = { isActive: true };
const FORMER_STAFF = { isActive: false };

describe("shouldUseDirectCandidateMessage", () => {
    it("routes an onboarding candidate directly", () => {
        expect(shouldUseDirectCandidateMessage({ status: "STAGING_ACTIVE" })).toBe(true);
        expect(shouldUseDirectCandidateMessage({ status: "TRAINING_SCHEDULED" })).toBe(true);
        expect(shouldUseDirectCandidateMessage({ status: "AWAITING_FIRST_SHIFT" })).toBe(true);
    });

    it("routes a screening candidate through support", () => {
        expect(shouldUseDirectCandidateMessage({ status: "SCREENING" })).toBe(false);
        expect(shouldUseDirectCandidateMessage({ status: "INTERVIEW_SCHEDULED" })).toBe(false);
    });

    it("routes an active staff member through support even with a stale candidate row", () => {
        // Це і є регрес: найм лишає рядок Candidate, і якщо він завис на
        // онбординговому статусі, повідомлення штатному фотографу йшло повз
        // підтримку — без гілки, куди він міг би відповісти.
        //
        // READY_FOR_HIRE — саме той статус, на якому 09.09.2026 зависла
        // анкета діючої співробітниці: гілка не створювалася, а екран
        // рапортував «Message sent and logged».
        expect(shouldUseDirectCandidateMessage({ status: "READY_FOR_HIRE" }, ACTIVE_STAFF)).toBe(false);
        expect(shouldUseDirectCandidateMessage({ status: "AWAITING_FIRST_SHIFT" }, ACTIVE_STAFF)).toBe(false);
        expect(shouldUseDirectCandidateMessage({ status: "STAGING_ACTIVE" }, ACTIVE_STAFF)).toBe(false);
        expect(shouldUseDirectCandidateMessage({ status: "OFFLINE_STAGING" }, ACTIVE_STAFF)).toBe(false);
    });

    it("routes a hired candidate through support", () => {
        // confirmFinalSchedule ставить HIRED, і цього статусу немає у списку
        // прямої відправки — тобто нормально найнятий співробітник і без
        // StaffProfile отримує гілку.
        expect(shouldUseDirectCandidateMessage({ status: "HIRED" })).toBe(false);
    });

    it("keeps the direct route for a deactivated staff member on onboarding", () => {
        // Неактивний профіль не має перекривати анкету: людина ще не працює.
        expect(shouldUseDirectCandidateMessage({ status: "STAGING_ACTIVE" }, FORMER_STAFF)).toBe(true);
    });

    it("routes someone without a candidate record through support", () => {
        expect(shouldUseDirectCandidateMessage(null)).toBe(false);
        expect(shouldUseDirectCandidateMessage(undefined)).toBe(false);
        expect(shouldUseDirectCandidateMessage({})).toBe(false);
    });
});
