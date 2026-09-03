import { describe, expect, it } from "vitest";

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

const candidate = (over: Partial<{ id: string; pipelineTouchedAt: Date; screeningReminderSentAt: Date | null }>) => ({
    id: "c1",
    pipelineTouchedAt: new Date(now.getTime() - 2 * DAY),
    screeningReminderSentAt: null,
    ...over,
});

describe("selectAbandonedScreeningCandidates", () => {
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
