import { afterEach, describe, expect, it, vi } from "vitest";
import { build14DayCalendar } from "../task-helpers.js";

/**
 * Кожна кнопка календаря показує ярлик (дата для людини) і несе callback_data
 * (дата, з якої фактично будується задача). Вони мають називати ОДИН і той
 * самий день.
 *
 * Раніше ярлик будувався з `date.getDate()` (локальний час сервера — тобто
 * UTC, бо контейнер TZ не задає), а callback_data — з
 * `date.toISOString().split("T")[0]` (теж UTC). На сервері з TZ=UTC вони
 * випадково збігались, але не з київським днем: репозиторій вважає Europe/Kyiv
 * своєю таймзоною (див. format-deadline.ts), і ввечері в Києві (після
 * 21:00 влітку, 22:00 взимку) київська доба вже наступна, поки UTC-доба ще
 * триває. Адмін тисне «Сьогодні», а задача повинна лягти на КИЇВСЬКИЙ
 * «сьогодні», а не на той день, який ще триває за UTC.
 */
describe("build14DayCalendar", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("labels the first button with the same day as its callback value at a plain daytime instant", () => {
        vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z")); // 15:00 Kyiv, no day-boundary ambiguity

        const [firstRow] = build14DayCalendar("task_dash_");
        const todayButton = firstRow![0]!;

        expect(todayButton.callback_data).toBe("task_dash_2026-09-17");
        expect(todayButton.text).toContain("17.09");
    });

    it("names the Kyiv day, not the UTC day, at a Kyiv evening instant that is already the next UTC-lagging day", () => {
        // 2026-09-17T21:30:00Z is 2026-09-18 00:30 in Kyiv (UTC+3, still summer
        // time in September). The Kyiv day has already rolled over to the
        // 18th, while the UTC calendar day is still the 17th.
        vi.setSystemTime(new Date("2026-09-17T21:30:00.000Z"));

        const [firstRow] = build14DayCalendar("task_dash_");
        const todayButton = firstRow![0]!;

        // The label and the callback value must always agree on which day
        // they name — whatever timezone that day is computed in.
        const callbackDate = todayButton.callback_data.replace("task_dash_", "");
        const labelMatch = /(\d{2})\.(\d{2})/.exec(todayButton.text);
        expect(labelMatch).not.toBeNull();
        const [, day, month] = labelMatch!;
        expect(callbackDate).toBe(`2026-${month}-${day}`);

        // And that shared day must be the Kyiv day (the 18th), not the UTC
        // day (the 17th) that the pre-fix implementation used for both.
        expect(callbackDate).toBe("2026-09-18");
    });
});
