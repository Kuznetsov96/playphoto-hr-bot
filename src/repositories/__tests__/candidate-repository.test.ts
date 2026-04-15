import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateStatus } from "@prisma/client";

const { findMany } = vi.hoisted(() => ({
    findMany: vi.fn(),
}));

vi.mock("../../db/core.js", () => ({
    default: {
        candidate: {
            findMany,
        }
    }
}));

vi.mock("../../core/logger.js", () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    }
}));

vi.mock("../../core/log-events.js", () => ({
    logAuditEvent: vi.fn(),
    logBusinessEvent: vi.fn(),
}));

import { candidateRepository } from "../candidate-repository.js";

describe("candidateRepository NDA queues", () => {
    beforeEach(() => {
        findMany.mockReset();
        findMany.mockResolvedValue([]);
    });

    it("loads awaiting NDA candidates from both NDA and legacy TRAINING_COMPLETED statuses", async () => {
        await candidateRepository.findAwaitingNDA();

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                status: { in: [CandidateStatus.TRAINING_COMPLETED, CandidateStatus.NDA] },
                ndaConfirmedAt: null,
            }),
            orderBy: [{ ndaSentAt: "asc" }, { statusChangedAt: "asc" }],
        }));
    });

    it("limits NDA reminders to candidates whose NDA was actually sent", async () => {
        await candidateRepository.findAwaitingNDAReminder(12);

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                status: { in: [CandidateStatus.TRAINING_COMPLETED, CandidateStatus.NDA] },
                ndaConfirmedAt: null,
                ndaSentAt: expect.objectContaining({ lte: expect.any(Date) }),
            }),
        }));
    });
});
