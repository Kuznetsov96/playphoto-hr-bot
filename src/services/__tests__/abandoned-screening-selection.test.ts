import { describe, expect, it } from "vitest";

import { CandidateStatus, FunnelStep } from "@prisma/client";

import { selectAbandonedScreeningCandidates } from "../abandoned-screening-selection.js";

/**
 * Кого догонять по брошенной анкете.
 *
 * До 03.09.2026 выборка шла по user.createdAt в окне 24–48 часов: кандидатка,
 * чей Telegram-аккаунт бот знал давно (вернулась, пришла по рассылке), не
 * попадала в неё никогда. В проде под напоминание не подпадали 376 из 420 в
 * SCREENING, из них 33 молчали дольше месяца.
 *
 * Считаем от последней активности; однократность держит отдельная отметка, а
 * не временное окно — джоб может отработать дважды за час.
 */
const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-03T11:00:00.000Z");

const candidate = (over: Partial<{ id: string; pipelineTouchedAt: Date; screeningReminderSentAt: Date | null; source: string | null; currentStep: FunnelStep }>) => ({
    id: "c1",
    status: CandidateStatus.SCREENING,
    currentStep: FunnelStep.INITIAL_TEST as FunnelStep,
    notificationSent: false,
    fullName: "Анна Коваль",
    gender: "female",
    birthDate: new Date("2005-01-01"),
    city: "Lviv",
    locationId: "loc-1",
    appearance: "Без особливостей",
    pipelineTouchedAt: new Date(now.getTime() - 2 * DAY),
    screeningReminderSentAt: null,
    source: null as string | null,
    ...over,
});

describe("selectAbandonedScreeningCandidates", () => {
    it("не трогает законченную анкету — SCREENING у неё значит «ждёт приглашения»", () => {
        // До 30.09.2026 напоминание «лишилося кілька питань» получали и те, кто
        // анкету закончил: 252 из 515 за месяц. Кнопка «Продовжити анкету» в нём
        // пересчитывала статус заново — вплоть до записанных на интервью.
        const rows = [candidate({ id: "done", source: "Instagram" })];

        expect(selectAbandonedScreeningCandidates(rows, now)).toEqual([]);
    });

    it("не трогает приглашённую, которая ещё не записалась", () => {
        const rows = [candidate({ id: "invited", currentStep: FunnelStep.INTERVIEW })];

        expect(selectAbandonedScreeningCandidates(rows, now)).toEqual([]);
    });

    it("берёт того, кто молчит дольше суток", () => {
        const rows = [candidate({ id: "a", pipelineTouchedAt: new Date(now.getTime() - 2 * DAY) })];

        expect(selectAbandonedScreeningCandidates(rows, now).map((r) => r.id)).toEqual(["a"]);
    });

    it("не трогает того, кто был активен час назад", () => {
        const rows = [candidate({ id: "b", pipelineTouchedAt: new Date(now.getTime() - 3_600_000) })];

        expect(selectAbandonedScreeningCandidates(rows, now)).toEqual([]);
    });

    it("не напоминает дважды", () => {
        const rows = [candidate({
            id: "c",
            pipelineTouchedAt: new Date(now.getTime() - 5 * DAY),
            screeningReminderSentAt: new Date(now.getTime() - 4 * DAY),
        })];

        expect(selectAbandonedScreeningCandidates(rows, now)).toEqual([]);
    });

    it("берёт давно молчащую: старый аккаунт больше не мешает", () => {
        const rows = [candidate({ id: "d", pipelineTouchedAt: new Date(now.getTime() - 40 * DAY) })];

        expect(selectAbandonedScreeningCandidates(rows, now).map((r) => r.id)).toEqual(["d"]);
    });

    it("фильтрует, а не пропускает всё подряд", () => {
        const rows = [
            candidate({ id: "молчит", pipelineTouchedAt: new Date(now.getTime() - 3 * DAY) }),
            candidate({ id: "активна", pipelineTouchedAt: new Date(now.getTime() - 60_000) }),
            candidate({ id: "уже-напомнили", screeningReminderSentAt: new Date(now.getTime() - DAY) }),
        ];

        expect(selectAbandonedScreeningCandidates(rows, now).map((r) => r.id)).toEqual(["молчит"]);
    });
});
