import { beforeEach, describe, expect, it, vi } from "vitest";

const staffFindMany = vi.fn();
const staffFindById = vi.fn();
const staffUpdate = vi.fn();
const firstShift = vi.fn();
const candidateFind = vi.fn();
const candidateUpdate = vi.fn();
const userUpdate = vi.fn();

vi.mock("../../../../repositories/staff-repository.js", () => ({
    staffRepository: {
        findMany: (...a: unknown[]) => staffFindMany(...a),
        findById: (...a: unknown[]) => staffFindById(...a),
        update: (...a: unknown[]) => staffUpdate(...a),
    },
}));
vi.mock("../../../../repositories/work-shift-repository.js", () => ({
    workShiftRepository: { findFirstForStaff: (...a: unknown[]) => firstShift(...a) },
}));
vi.mock("../../../../repositories/candidate-repository.js", () => ({
    candidateRepository: {
        findByUserId: (...a: unknown[]) => candidateFind(...a),
        update: (...a: unknown[]) => candidateUpdate(...a),
    },
}));
vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: { update: (...a: unknown[]) => userUpdate(...a) },
}));

const { staffService } = await import("../index.js");

const DAY_MS = 24 * 60 * 60 * 1000;

const staff = (id: string) => ({
    id,
    userId: `user-${id}`,
    fullName: "Бланк Анастасія Тарасівна",
    isWelcomeSent: false,
    user: { telegramId: 100n, role: "CANDIDATE" },
});

beforeEach(() => {
    vi.clearAllMocks();
    staffUpdate.mockResolvedValue({});
    candidateFind.mockResolvedValue({ id: "cand-1", status: "MENTOR_MANUAL" });
    candidateUpdate.mockResolvedValue({});
    userUpdate.mockResolvedValue({});
});

describe("activatePendingStaff", () => {
    it("welcomes a new hire whose first shift is still ahead, without promising a mentor", async () => {
        staffFindMany.mockResolvedValue([staff("s1")]);
        staffFindById.mockResolvedValue(staff("s1"));
        firstShift.mockResolvedValue({ date: new Date(Date.now() + 2 * DAY_MS) });
        const api = { sendMessage: vi.fn().mockResolvedValue({}) };

        const result = await staffService.activatePendingStaff(api);

        expect(result).toMatchObject({ welcomed: 1, silenced: 0, failed: 0, activatedIds: ["s1"] });
        expect(api.sendMessage).toHaveBeenCalledOnce();
        const text = api.sendMessage.mock.calls[0]![1] as string;
        expect(text).toContain("Вітаємо в команді, Анастасія!");
        expect(text).not.toMatch(/наставн/iu);
        expect(staffUpdate).toHaveBeenCalledWith("s1", { isWelcomeSent: true });
    });

    // 01.10.2026: 20 людей працювали тижнями без привітання. «Вітаємо в команді»
    // після місяця змін читається як збій — їх закриваємо мовчки.
    it("activates silently someone whose first shift has already passed", async () => {
        staffFindMany.mockResolvedValue([staff("s2")]);
        staffFindById.mockResolvedValue(staff("s2"));
        firstShift.mockResolvedValue({ date: new Date(Date.now() - 10 * DAY_MS) });
        const api = { sendMessage: vi.fn() };

        const result = await staffService.activatePendingStaff(api);

        expect(result).toMatchObject({ welcomed: 0, silenced: 1, activatedIds: ["s2"] });
        expect(api.sendMessage).not.toHaveBeenCalled();
        expect(staffUpdate).toHaveBeenCalledWith("s2", { isWelcomeSent: true });
    });

    it("moves the candidate card to HIRED and the user to STAFF in both cases", async () => {
        staffFindMany.mockResolvedValue([staff("s3")]);
        staffFindById.mockResolvedValue(staff("s3"));
        firstShift.mockResolvedValue({ date: new Date(Date.now() - DAY_MS) });

        await staffService.activatePendingStaff({ sendMessage: vi.fn() });

        expect(candidateUpdate).toHaveBeenCalledWith("cand-1", expect.objectContaining({ status: "HIRED" }));
        expect(userUpdate).toHaveBeenCalledWith("user-s3", { role: "STAFF" });
    });

    it("counts a hire who never started the bot as failed, not welcomed", async () => {
        staffFindMany.mockResolvedValue([staff("s4")]);
        staffFindById.mockResolvedValue(staff("s4"));
        firstShift.mockResolvedValue({ date: new Date(Date.now() + DAY_MS) });
        const api = { sendMessage: vi.fn().mockRejectedValue(new Error("Forbidden: bot was blocked")) };

        const result = await staffService.activatePendingStaff(api);

        expect(result).toMatchObject({ welcomed: 0, failed: 1 });
    });
});
