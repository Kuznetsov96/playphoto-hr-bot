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
                id: "cand-underage",
                fullName: "Underage Candidate",
                status: "REJECTED",
                gender: "female",
                hrDecision: "REJECTED_SYSTEM_UNDERAGE",
                birthDate: new Date("2009-04-12T00:00:00.000Z"),
                user: { telegramId: 1003n },
            },
        ]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("greets all deliverable candidates and reactivates exact-17 underage profiles", async () => {
        const { greetCandidateBirthdays } = await import("../birthday-service.js");

        const sentCount = await greetCandidateBirthdays({ api: { sendMessage } } as any, 12, 4);

        expect(sentCount).toBe(3);
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
        expect(updateCandidate).toHaveBeenCalledWith("cand-underage", expect.objectContaining({
            status: "WAITLIST_HR",
            hrDecision: null,
        }));
        expect(sendMessage).toHaveBeenCalledWith(
            1003,
            expect.stringContaining("Сьогодні тобі виповнилося 17"),
            expect.objectContaining({ parse_mode: "HTML" })
        );
    });
});