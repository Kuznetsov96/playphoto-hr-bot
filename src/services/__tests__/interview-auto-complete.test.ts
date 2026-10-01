import { beforeEach, describe, expect, it, vi } from "vitest";

const { findOverdueBooked, updateSlot, update, handleBlockedCandidate } = vi.hoisted(() => ({
    findOverdueBooked: vi.fn(),
    updateSlot: vi.fn(),
    update: vi.fn(),
    handleBlockedCandidate: vi.fn(),
}));

vi.mock("../../repositories/interview-repository.js", () => ({ interviewRepository: { findOverdueBooked, updateSlot } }));
vi.mock("../../repositories/candidate-repository.js", () => ({ candidateRepository: { update } }));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));
vi.mock("../../core/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../utils/bot-blocked.js", () => ({
    isBotBlocked: (e: any) => e?.error_code === 403,
    handleBlockedCandidate,
}));

const THANKS = "<b>Дякуємо за розмову</b>\n\nРішення надішлемо сюди, у цей чат, протягом доби.";

function overdueSlot(hrDecision: string | null) {
    return {
        id: "slot-1",
        endTime: new Date("2026-10-01T11:15:00.000Z"),
        candidate: { id: "cand-1", fullName: "Анна", hrDecision, user: { telegramId: 555n } },
    };
}

/**
 * Після автозавершення співбесіди кандидатка раніше не отримувала нічого
 * (аудит 01.10.2026). Подяку шлемо лише без рішення HR: прийняття чи
 * відмова в цей момент уже пішли окремим повідомленням.
 */
describe("autoCompleteOverdueInterviews", () => {
    beforeEach(() => {
        findOverdueBooked.mockReset();
        updateSlot.mockReset();
        update.mockReset();
        handleBlockedCandidate.mockReset();
    });

    it("без решения HR — завершает и пишет благодарность", async () => {
        const { autoCompleteOverdueInterviews } = await import("../interview-auto-complete.js");
        findOverdueBooked.mockResolvedValue([overdueSlot(null)]);
        const api = { sendMessage: vi.fn() };

        await autoCompleteOverdueInterviews(api);

        expect(update).toHaveBeenCalledWith("cand-1", expect.objectContaining({ status: "INTERVIEW_COMPLETED" }));
        expect(updateSlot).toHaveBeenCalledWith("slot-1", { remindedCompletion: true });
        expect(api.sendMessage).toHaveBeenCalledWith(555, THANKS, { parse_mode: "HTML" });
    });

    it.each(["ACCEPTED", "REJECTED"])("решение HR уже есть (%s) — ничего не пишет", async (hrDecision) => {
        const { autoCompleteOverdueInterviews } = await import("../interview-auto-complete.js");
        findOverdueBooked.mockResolvedValue([overdueSlot(hrDecision)]);
        const api = { sendMessage: vi.fn() };

        await autoCompleteOverdueInterviews(api);

        expect(update).toHaveBeenCalledWith("cand-1", expect.objectContaining({ status: "INTERVIEW_COMPLETED" }));
        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("слот помечается до отправки: сбой Telegram не повторяет благодарность на следующем тике", async () => {
        const { autoCompleteOverdueInterviews } = await import("../interview-auto-complete.js");
        findOverdueBooked.mockResolvedValue([overdueSlot(null)]);
        const order: string[] = [];
        updateSlot.mockImplementation(async () => { order.push("mark"); });
        const api = { sendMessage: vi.fn(async () => { order.push("send"); throw new Error("socket hang up"); }) };

        await autoCompleteOverdueInterviews(api);

        expect(order).toEqual(["mark", "send"]);
    });

    it("запись статуса упала — не пишет", async () => {
        const { autoCompleteOverdueInterviews } = await import("../interview-auto-complete.js");
        findOverdueBooked.mockResolvedValue([overdueSlot(null)]);
        update.mockRejectedValue(new Error("guard"));
        const api = { sendMessage: vi.fn() };

        await autoCompleteOverdueInterviews(api);

        expect(api.sendMessage).not.toHaveBeenCalled();
    });

    it("бот заблокирован — помечает кандидатку", async () => {
        const { autoCompleteOverdueInterviews } = await import("../interview-auto-complete.js");
        findOverdueBooked.mockResolvedValue([overdueSlot(null)]);
        const api = { sendMessage: vi.fn().mockRejectedValue({ error_code: 403 }) };

        await autoCompleteOverdueInterviews(api);

        expect(handleBlockedCandidate).toHaveBeenCalledWith(api, "cand-1", "Анна");
    });
});
