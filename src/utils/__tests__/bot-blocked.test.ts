import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateStatus } from "@prisma/client";

const findById = vi.fn();
const archiveBlockedCandidate = vi.fn();
const sendMessage = vi.fn();

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findById,
        archiveBlockedCandidate,
    }
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        info: vi.fn(),
    }
}));

describe("handleBlockedCandidate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sendMessage.mockResolvedValue(undefined);
    });

    it("archives candidate as blocker without sending a Telegram alert — HR sees it in the web inbox", async () => {
        findById.mockResolvedValue({
            id: "cand-1",
            status: CandidateStatus.SCREENING,
            user: { botBlockedAt: null },
        });

        const { handleBlockedCandidate, BLOCKED_CANDIDATE_DECISION } = await import("../bot-blocked.js");

        await handleBlockedCandidate({ sendMessage } as any, "cand-1", "Jane Doe");

        expect(archiveBlockedCandidate).toHaveBeenCalledWith("cand-1", BLOCKED_CANDIDATE_DECISION);
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("does not reprocess candidate already archived with botBlockedAt", async () => {
        findById.mockResolvedValue({
            id: "cand-2",
            status: CandidateStatus.BLOCKER,
            user: { botBlockedAt: new Date("2026-04-12T10:00:00Z") },
        });

        const { handleBlockedCandidate } = await import("../bot-blocked.js");

        await handleBlockedCandidate({ sendMessage } as any, "cand-2", "Jane Doe");

        expect(archiveBlockedCandidate).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
    });
});