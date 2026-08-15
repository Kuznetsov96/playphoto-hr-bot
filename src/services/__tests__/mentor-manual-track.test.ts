import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
    findById: vi.fn(),
    update: vi.fn(),
    findByStatusWithUser: vi.fn(),
    syncUserAccess: vi.fn(),
    createInviteLink: vi.fn(),
    audit: vi.fn(),
    sendMessage: vi.fn(),
}));

vi.mock("../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findById: mocks.findById,
        update: mocks.update,
        findByStatusWithUser: mocks.findByStatusWithUser,
    },
}));
vi.mock("../access-service.js", () => ({
    accessService: {
        syncUserAccess: mocks.syncUserAccess,
        createInviteLink: mocks.createInviteLink,
        staticJoinLink: "https://t.me/+static",
    },
}));
vi.mock("../../core/audit-logger.js", () => ({ audit: mocks.audit }));
vi.mock("../../core/logger.js", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const api = { sendMessage: mocks.sendMessage } as any;

describe("mentor manual track", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.update.mockResolvedValue({});
        mocks.sendMessage.mockResolvedValue(undefined);
    });

    // First test in the file, so it absorbs the module-loading cost of the whole service chain;
    // it sat close enough to vitest's 5s default that unrelated suite growth failed it.
    it("lists MENTOR_MANUAL candidates", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findByStatusWithUser.mockResolvedValue([{ id: "c1", mentorManualContactedAt: null }]);

        const result = await mentorService.getManualMentorCandidates();

        expect(mocks.findByStatusWithUser).toHaveBeenCalledWith(CandidateStatus.MENTOR_MANUAL);
        expect(result).toEqual([{ id: "c1", mentorManualContactedAt: null }]);
    }, 30_000);

    it("puts not-contacted manual candidates first", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findByStatusWithUser.mockResolvedValue([
            { id: "contacted", mentorManualContactedAt: new Date("2026-06-01T10:00:00.000Z") },
            { id: "fresh", mentorManualContactedAt: null },
        ]);

        const result = await mentorService.getManualMentorCandidates();

        expect(result.map((candidate) => candidate.id)).toEqual(["fresh", "contacted"]);
    });

    it("marks manual candidate as contacted", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({
            id: "c1",
            status: CandidateStatus.MENTOR_MANUAL,
            user: { telegramId: 555n },
        });
        mocks.update.mockResolvedValue({ id: "c1" });

        const res = await mentorService.setManualMentorContacted("c1", true);

        expect(mocks.update).toHaveBeenCalledWith("c1", {
            mentorManualContactedAt: expect.any(Date),
        });
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
            event: "candidate_manual_mentor_contact_marked",
            context: { contacted: true },
        }));
        expect(res?.success).toBe(true);
    });

    it("does not mark non-manual candidates as contacted", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({
            id: "c1",
            status: CandidateStatus.ACCEPTED,
        });

        const res = await mentorService.setManualMentorContacted("c1", true);

        expect(res).toBeNull();
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it("accept advances candidate to NDA", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({
            id: "c1",
            fullName: "Anna",
            status: CandidateStatus.MENTOR_MANUAL,
            user: { telegramId: 555n },
            location: { name: "Smile" },
        });

        const res = await mentorService.acceptManualMentor(api, "c1");

        expect(mocks.update).toHaveBeenCalledWith("c1", expect.objectContaining({
            status: CandidateStatus.NDA,
        }));
        expect(mocks.sendMessage).toHaveBeenCalled();
        expect(res?.success).toBe(true);
    });

    it("reject sets REJECTED and revokes access", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({
            id: "c1",
            fullName: "Anna",
            status: CandidateStatus.MENTOR_MANUAL,
            user: { telegramId: 555n },
        });

        const res = await mentorService.rejectManualMentor("c1");

        expect(mocks.update).toHaveBeenCalledWith("c1", expect.objectContaining({
            status: CandidateStatus.REJECTED,
        }));
        expect(mocks.syncUserAccess).toHaveBeenCalledWith(555n, "Manual mentor reject");
        expect(res?.success).toBe(true);
    });

    it("accept returns null when candidate not found", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue(null);
        const res = await mentorService.acceptManualMentor(api, "missing");
        expect(res).toBeNull();
        expect(mocks.update).not.toHaveBeenCalled();
    });

    it("audits failed result when channel link cannot be generated", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({ id: "c1", user: { telegramId: 555n } });
        mocks.createInviteLink.mockResolvedValue(null);

        const link = await mentorService.generateChannelLinkForMentor("c1");

        expect(link).toBeNull();
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
            event: "mentor_channel_link_generated",
            result: "failed",
        }));
    });

    it("generates a one-time channel link", async () => {
        const { mentorService } = await import("../mentor-service.js");
        mocks.findById.mockResolvedValue({ id: "c1", user: { telegramId: 555n } });
        mocks.createInviteLink.mockResolvedValue("https://t.me/+invite");

        const link = await mentorService.generateChannelLinkForMentor("c1");

        expect(mocks.createInviteLink).toHaveBeenCalledWith(555n);
        expect(link).toBe("https://t.me/+invite");
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
            event: "mentor_channel_link_generated",
        }));
    });
});
