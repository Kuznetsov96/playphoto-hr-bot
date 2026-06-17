import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findBirthdaysToday = vi.fn();
const updateCandidate = vi.fn();
const sendMessage = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findBirthdaysToday,
        update: updateCandidate,
    }
}));

vi.mock("../../repositories/user-repository.js", () => ({
    userRepository: {}
}));

vi.mock("../../repositories/staff-repository.js", () => ({
    staffRepository: {
        findActive: vi.fn().mockResolvedValue([]),
    }
}));

vi.mock("../../repositories/location-repository.js", () => ({
    locationRepository: {}
}));

vi.mock("../../config.js", () => ({
    ADMIN_IDS: [111],
    CO_FOUNDER_IDS: [],
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }
}));

vi.mock("../../core/log-events.js", () => ({
    logAuditEvent: vi.fn(),
    logBusinessEvent: vi.fn(),
}));

vi.mock("../../utils/bot-blocked.js", () => ({
    isBotBlocked: vi.fn().mockReturnValue(false),
    handleBlockedCandidate: vi.fn(),
}));

vi.mock("../../db/core.js", () => ({
    default: {}
}));

describe("greetCandidateBirthdays", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-12T09:00:00.000Z"));
        vi.clearAllMocks();
        sendMessage.mockResolvedValue({});
        findBirthdaysToday.mockResolvedValue([
            {
                id: "cand-rejected",
                fullName: "Rejected Candidate",
                status: "REJECTED",
                gender: "male",
                hrDecision: null,
                birthDate: new Date("2000-04-12T00:00:00.000Z"),
                user: { telegramId: 1001n },
            },
            {
                id: "cand-blocker",
                fullName: "Blocked Candidate",
                status: "BLOCKER",
                gender: "female",
                hrDecision: null,
                birthDate: new Date("2003-04-12T00:00:00.000Z"),
                user: { telegramId: 1002n },
            },
            {
                id: "cand-underage-ready",
                fullName: "Underage Ready Candidate",
                status: "REJECTED",
                gender: "female",
                hrDecision: "REJECTED_SYSTEM_UNDERAGE",
                birthDate: new Date("2009-04-12T00:00:00.000Z"),
                city: "Запоріжжя",
                locationId: "loc-1",
                user: { telegramId: 1003n },
            },
            {
                id: "cand-underage-incomplete",
                fullName: "Underage Incomplete Candidate",
                status: "REJECTED",
                gender: "female",
                hrDecision: "REJECTED_SYSTEM_UNDERAGE",
                birthDate: new Date("2009-04-12T00:00:00.000Z"),
                city: null,
                locationId: null,
                user: { telegramId: 1004n },
            },
        ]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("greets all deliverable candidates and reactivates exact-17 complete underage profiles to HR waitlist", async () => {
        const { greetCandidateBirthdays } = await import("../birthday-service.js");

        const sentCount = await greetCandidateBirthdays({ api: { sendMessage } } as any, 12, 4);

        expect(sentCount).toBe(4);
        expect(sendMessage).toHaveBeenCalledWith(
            1001,
            expect.stringContaining("З днем народження"),
            expect.objectContaining({ parse_mode: "HTML" })
        );
        expect(sendMessage).toHaveBeenCalledWith(
            1002,
            expect.stringContaining("З днем народження"),
            expect.objectContaining({ parse_mode: "HTML" })
        );
        expect(updateCandidate).toHaveBeenCalledWith("cand-underage-ready", expect.objectContaining({
            status: "WAITLIST_HR",
            hrDecision: null,
            isWaitlisted: true,
            currentStep: "INTERVIEW",
        }));
        expect(sendMessage).toHaveBeenCalledWith(
            1003,
            expect.stringContaining("Ми повернули твою анкету до списку актуальних"),
            expect.objectContaining({ parse_mode: "HTML" })
        );
    });

    it("returns exact-17 incomplete underage profiles to screening with a resume button", async () => {
        const { greetCandidateBirthdays } = await import("../birthday-service.js");

        await greetCandidateBirthdays({ api: { sendMessage } } as any, 12, 4);

        expect(updateCandidate).toHaveBeenCalledWith("cand-underage-incomplete", expect.objectContaining({
            status: "SCREENING",
            hrDecision: null,
            isWaitlisted: false,
            currentStep: "INITIAL_TEST",
            notificationSent: false,
            interviewWaitlistReason: null,
            interviewInvitedAt: null,
        }));
        expect(sendMessage).toHaveBeenCalledWith(
            1004,
            expect.stringContaining("Натисни кнопку нижче"),
            expect.objectContaining({
                parse_mode: "HTML",
                reply_markup: expect.any(Object),
            })
        );
    });
});
