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
        findByUserId: (...a: unknown[]) => staffByUser(...a),
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
const userByTelegram = vi.fn();
const staffByUser = vi.fn();
vi.mock("../../../../repositories/user-repository.js", () => ({
    userRepository: {
        update: (...a: unknown[]) => userUpdate(...a),
        findByTelegramId: (...a: unknown[]) => userByTelegram(...a),
    },
}));

const { staffService } = await import("../index.js");

const DAY_MS = 24 * 60 * 60 * 1000;

const staff = (id: string) => ({
    id,
    isActive: true,
    onboardingDate: new Date(Date.now() - DAY_MS),
    userId: `user-${id}`,
    // Порядок у fullName ненадійний: у частини людей ім'я стоїть першим.
    fullName: "Анастасія Бланк Тарасівна",
    isWelcomeSent: false,
    user: { telegramId: 100n, role: "CANDIDATE", firstName: "Анастасія" },
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

    it("takes the first name from the web app field, not from the order of words in fullName", async () => {
        const reversed = { ...staff("s5"), fullName: "Бланк Анастасія Тарасівна" };
        staffFindMany.mockResolvedValue([reversed]);
        staffFindById.mockResolvedValue(reversed);
        firstShift.mockResolvedValue({ date: new Date(Date.now() + DAY_MS) });
        const api = { sendMessage: vi.fn().mockResolvedValue({}) };

        await staffService.activatePendingStaff(api);

        expect(api.sendMessage.mock.calls[0]![1]).toContain("Вітаємо в команді, Анастасія!");
    });

    it("greets without a name rather than guessing when the web app has none", async () => {
        const nameless = { ...staff("s6"), user: { telegramId: 100n, role: "STAFF", firstName: null } };
        staffFindMany.mockResolvedValue([nameless]);
        staffFindById.mockResolvedValue(nameless);
        firstShift.mockResolvedValue({ date: new Date(Date.now() + DAY_MS) });
        const api = { sendMessage: vi.fn().mockResolvedValue({}) };

        await staffService.activatePendingStaff(api);

        expect(api.sendMessage.mock.calls[0]![1]).toContain("<b>Вітаємо в команді!</b>");
    });

    it("counts a hire who never started the bot as failed, not welcomed", async () => {
        staffFindMany.mockResolvedValue([staff("s4")]);
        staffFindById.mockResolvedValue(staff("s4"));
        firstShift.mockResolvedValue({ date: new Date(Date.now() + DAY_MS) });
        const api = { sendMessage: vi.fn().mockRejectedValue(new Error("Forbidden: bot was blocked")) };

        const result = await staffService.activatePendingStaff(api);

        expect(result).toMatchObject({ welcomed: 0, failed: 1 });
    });

    it("silences an old employee who never got a welcome even if a shift is ahead", async () => {
        const veteran = { ...staff("s7"), onboardingDate: new Date(Date.now() - 60 * DAY_MS) };
        staffFindMany.mockResolvedValue([veteran]);
        staffFindById.mockResolvedValue(veteran);
        firstShift.mockResolvedValue({ date: new Date(Date.now() + DAY_MS) });
        const api = { sendMessage: vi.fn() };

        const result = await staffService.activatePendingStaff(api);

        expect(result).toMatchObject({ welcomed: 0, silenced: 1 });
        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});

describe("welcomeBeforeScheduleMessage", () => {
    // Сповіщення про графік приходить за хвилину, активація — за 5–10. Без цього
    // новенька читала «Оновлення у твоєму графіку» раніше за «Вітаємо в команді».
    it("welcomes a new hire right before her first schedule message", async () => {
        userByTelegram.mockResolvedValue({ id: "user-s1", adminRole: null });
        staffByUser.mockResolvedValue(staff("s1"));
        staffFindById.mockResolvedValue(staff("s1"));
        const api = { sendMessage: vi.fn().mockResolvedValue({}) };

        await expect(staffService.welcomeBeforeScheduleMessage("100", api)).resolves.toBe(true);

        expect(api.sendMessage.mock.calls[0]![1]).toContain("Вітаємо в команді");
    });

    it("stays silent for someone already welcomed or hired long ago", async () => {
        userByTelegram.mockResolvedValue({ id: "user-x", adminRole: null });
        const api = { sendMessage: vi.fn() };

        staffByUser.mockResolvedValueOnce({ ...staff("a"), isWelcomeSent: true });
        await staffService.welcomeBeforeScheduleMessage("100", api);
        staffByUser.mockResolvedValueOnce({ ...staff("b"), onboardingDate: new Date(Date.now() - 60 * DAY_MS) });
        await staffService.welcomeBeforeScheduleMessage("100", api);

        expect(api.sendMessage).not.toHaveBeenCalled();
    });
});
