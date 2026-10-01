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
    // Рішення власника 01.10.2026: блок «Твоя робота» — зі знімка вебаппа,
    // без вигаданих «Гнучкий»/«20-30%», а без даних — немає й заголовка.
    it("прийнята бачить блок «Твоя робота» з даними вебаппа", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");

        await showCandidateStatus({} as any, {
            status: "MENTOR_MANUAL", gender: "female",
            location: {
                id: "l1", name: "Leoland", city: "Львів", branch: null, address: "Львів, вул. Мельника 18",
                openingHours: [{ dayOfWeek: 6, opens: "10:00", closes: "22:00" }, { dayOfWeek: 7, opens: "10:00", closes: "22:00" }],
                pay: {
                    weekdayPercent: 25, weekendPercent: 25, weekdayPairPercent: 0,
                    weekendPairPercent: 0, weekdayGuarantee: 0, weekendGuarantee: 0,
                },
            },
        });

        const [, text] = renderScreen.mock.calls[0]!;
        expect(text).toContain("<b>Твоя робота:</b>\n<b>Leoland (Lviv)</b>\nАдреса: Львів, вул. Мельника 18\nГодини роботи: Сб–Нд 10:00–22:00\nОплата: 25 % від виручки щодня");
        expect(text).not.toContain("Гарантія");
    });

    it("без жодних даних точки блоку немає зовсім", async () => {
        const { showCandidateStatus } = await import("../candidate-ui.js");

        await showCandidateStatus({} as any, {
            status: "MENTOR_MANUAL", gender: "female",
            location: { id: "l1", name: "Leoland", city: "Львів", address: null, openingHours: [], pay: null },
        });

        const [, text] = renderScreen.mock.calls[0]!;
        expect(text).not.toContain("Твоя робота");
        expect(text).not.toContain("Гнучкий");
        expect(text).not.toContain("20-30%");
    });
});
