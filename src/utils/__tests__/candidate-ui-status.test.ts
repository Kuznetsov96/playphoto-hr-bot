import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderScreen } = vi.hoisted(() => ({ renderScreen: vi.fn() }));
vi.mock("../screen-manager.js", () => ({ ScreenManager: { renderScreen } }));
vi.mock("../cleanup.js", () => ({ cleanupMessages: vi.fn(), trackMessage: vi.fn() }));

function buttons(kb: any): string[] {
    return (kb?.inline_keyboard ?? []).flat().map((button: any) => button.text);
}

describe("showCandidateStatus", () => {
    beforeEach(() => renderScreen.mockReset());

    it("принятая после оффера (MENTOR_MANUAL) видит приветствие команды, а не «на розгляді»", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");
        const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");

        await showCandidateStatus({} as any, { status: "MENTOR_MANUAL", gender: "female" });

        const [, text, kb] = renderScreen.mock.calls[0]!;
        expect(text).toContain(CANDIDATE_TEXTS["candidate-accepted-welcome"]());
        expect(buttons(kb)).toContain("Написати нам");
    });

    it("приглашённая видит кнопку выбора времени", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");

        await showCandidateStatus({} as any, {
            status: "SCREENING", gender: "female", currentStep: "INITIAL_TEST",
            notificationSent: true, interviewSlotId: null, city: "Lviv",
        });

        const [, , kb] = renderScreen.mock.calls[0]!;
        expect(buttons(kb)).toContain("Обрати час");
    });

    it("законченная анкета без приглашения — без кнопки выбора времени", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");
        const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");

        await showCandidateStatus({} as any, {
            status: "SCREENING", gender: "female", currentStep: "INITIAL_TEST", notificationSent: false,
            fullName: "Анна Коваль", birthDate: new Date("2005-01-01"), city: "Lviv", locationId: "l1",
            appearance: "Без особливостей", source: "Instagram",
        });

        const [, text, kb] = renderScreen.mock.calls[0]!;
        expect(text).toBe(CANDIDATE_TEXTS["candidate-success-screening"]);
        expect(buttons(kb)).not.toContain("Обрати час");
    });

    it("принятая на этапах после решения не получает обещания «напишемо щодо навчання»", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");

        await showCandidateStatus({} as any, { status: "AWAITING_FIRST_SHIFT", gender: "female" });

        const [, text] = renderScreen.mock.calls[0]!;
        expect(text).toContain("Навчання, стажування й документи погоджуємо з тобою особисто.");
        expect(text).not.toContain("найближчим часом");
    });

    it("HIRED без кабинета не отправляет по кругу на /start", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");

        await showCandidateStatus({} as any, { status: "HIRED", gender: "female" });

        const [, text] = renderScreen.mock.calls[0]!;
        expect(text).toBe("<b>Вітаємо в команді</b>\n\nРобочий кабінет відкриється, щойно в графіку з’явиться твоя перша зміна.");
        expect(text).not.toContain("/start");
    });

    it("после интервью без решения — та же благодарность, что шлёт воркер", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");

        await showCandidateStatus({} as any, { status: "INTERVIEW_COMPLETED", gender: "female", hrDecision: null });

        const [, text] = renderScreen.mock.calls[0]!;
        expect(text.startsWith("<b>Дякуємо за розмову</b>\n\nРішення надішлемо сюди, у цей чат, протягом доби.")).toBe(true);
    });

    it("приглашение на /start: точка с филиалом, без точки — без строки про локацию", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");
        const invited = {
            status: "SCREENING", gender: "female", currentStep: "INITIAL_TEST",
            notificationSent: true, interviewSlotId: null, city: "Zaporizhzhia",
        };

        await showCandidateStatus({} as any, { ...invited, location: { name: "Volkland", city: "Zaporizhzhia", branch: "Шевчик" } });
        await showCandidateStatus({} as any, { ...invited, location: null });

        expect(renderScreen.mock.calls[0]![1]).toContain("локація <b>Volkland (Шевчик)</b>");
        expect(renderScreen.mock.calls[1]![1]).toBe("<b>Анкету розглянуто</b>\n\nЗапрошуємо вас на онлайн-співбесіду.\n\nОберіть зручний час:");
    });
});

describe("selectRejectedStatusText: экран /start после отказа по причине", () => {
    const WITHDRAWN = "<b>Заявку закрито</b>\n\nВи завершили заявку. Дякуємо, що повідомили.";

    it.each([
        "Кандидатка відмовилась від вакансії",
        "Відмова кандидата (не актуально)",
        "Кандидатка відмовилась від вакансії на mentor-етапі",
        "Кандидатка відмовилась від участі на етапі офлайн-стажування",
    ])("сама закрыла заявку (%s) — не наш отказ", async (candidateDecision) => {
        const { selectRejectedStatusText } = await import("../candidate-ui.js");

        // decline_invite пишет и hrDecision "REJECTED" — решает candidateDecision.
        expect(selectRejectedStatusText({ status: "REJECTED", gender: "female", hrDecision: "REJECTED", candidateDecision })).toBe(WITHDRAWN);
    });

    it("младше 17 — тот же текст, что пришёл при отказе", async () => {
        const { selectRejectedStatusText } = await import("../candidate-ui.js");
        const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");

        expect(selectRejectedStatusText({ status: "REJECTED", gender: "female", hrDecision: "REJECTED_SYSTEM_UNDERAGE", candidateDecision: null }))
            .toBe(CANDIDATE_TEXTS["candidate-reject-underage"]);
        expect(selectRejectedStatusText({ status: "REJECTED", gender: "male", hrDecision: "REJECTED_SYSTEM_UNDERAGE", candidateDecision: null }))
            .toBe(CANDIDATE_TEXTS["candidate-reject-male-location"]);
    });

    it("отказ HR и неявка — общий отказ", async () => {
        const { selectRejectedStatusText } = await import("../candidate-ui.js");
        const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");

        expect(selectRejectedStatusText({ status: "REJECTED", hrDecision: "REJECTED", candidateDecision: null })).toBe(CANDIDATE_TEXTS["candidate-rejected"]);
        expect(selectRejectedStatusText({ status: "REJECTED", hrDecision: "NOSHOW", candidateDecision: null })).toBe(CANDIDATE_TEXTS["candidate-rejected"]);
    });

    it("«Бот заблоковано» — не её решение: общий отказ и кнопка восстановления остаются", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");
        const { CANDIDATE_TEXTS } = await import("../../constants/candidate-texts.js");
        renderScreen.mockReset();
        const now = new Date();

        await showCandidateStatus({} as any, {
            status: "REJECTED", gender: "female",
            birthDate: new Date(now.getFullYear() - 20, 0, 1),
            candidateDecision: "Бот заблоковано / контакт призупинено",
        });

        const [, text, kb] = renderScreen.mock.calls[0]!;
        expect(text.startsWith(CANDIDATE_TEXTS["candidate-rejected"])).toBe(true);
        expect(buttons(kb)).toContain("Написати нам");
    });
});
