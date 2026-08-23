import { describe, expect, it } from "vitest";
import { isQuietHour, kyivHour, nextAllowedPingTime } from "../quiet-hours.js";

/** Час по Киеву для читаемости ожиданий. */
function hourOf(date: Date): number {
    return kyivHour(date);
}

describe("isQuietHour", () => {
    it("treats the middle of the night as quiet", () => {
        // 02:00 Kyiv — то самое напоминание, ради которого окно и заводится.
        expect(isQuietHour(new Date("2026-08-26T23:00:00Z"))).toBe(true);
    });

    it("treats the working day as loud", () => {
        expect(isQuietHour(new Date("2026-08-26T11:00:00Z"))).toBe(false); // 14:00 Kyiv
    });

    /** Границы включительно/исключительно: 22:00 уже тихо, 10:00 уже можно. */
    it("closes at 22:00 and opens at 10:00 Kyiv", () => {
        const closes = new Date("2026-08-26T19:00:00Z"); // 22:00 Kyiv
        const opens = new Date("2026-08-26T07:00:00Z"); // 10:00 Kyiv

        expect(hourOf(closes)).toBe(22);
        expect(hourOf(opens)).toBe(10);
        expect(isQuietHour(closes)).toBe(true);
        expect(isQuietHour(opens)).toBe(false);
    });

    it("is still quiet one minute before the window opens", () => {
        const almost = new Date("2026-08-26T06:59:00Z"); // 09:59 Kyiv
        expect(isQuietHour(almost)).toBe(true);
    });
});

describe("nextAllowedPingTime", () => {
    it("leaves a daytime reminder exactly where it is", () => {
        const noon = new Date("2026-08-26T11:00:00Z");

        expect(nextAllowedPingTime(noon).getTime()).toBe(noon.getTime());
    });

    /**
     * Свойство, ради которого функция существует: ночное напоминание уходит
     * утром, а не просто позже. Прибавление интервала снова попало бы в ночь.
     */
    it("moves a night reminder to the next morning", () => {
        const night = new Date("2026-08-26T23:00:00Z"); // 02:00 Kyiv

        const moved = nextAllowedPingTime(night);

        expect(hourOf(moved)).toBe(10);
        expect(moved.getTime()).toBeGreaterThan(night.getTime());
    });

    it("moves a late-evening reminder to the following morning", () => {
        const evening = new Date("2026-08-26T20:00:00Z"); // 23:00 Kyiv

        const moved = nextAllowedPingTime(evening);

        expect(hourOf(moved)).toBe(10);
        // Тот же ночной интервал — значит утро СЛЕДУЮЩЕГО дня, а не текущего.
        expect(moved.getTime() - evening.getTime()).toBeLessThan(24 * 3600 * 1000);
    });

    /**
     * Переход на летнее/зимнее время. Захардкоженное смещение +2/+3 промахнулось
     * бы на час именно в дни сбора пожеланий на ноябрь и на апрель.
     */
    it("lands on 10:00 Kyiv across the autumn clock change", () => {
        // Ночь на 25.10.2026 — переход на зимнее время в Украине.
        const night = new Date("2026-10-25T01:00:00Z");

        expect(hourOf(nextAllowedPingTime(night))).toBe(10);
    });

    it("lands on 10:00 Kyiv across the spring clock change", () => {
        // Ночь на 29.03.2026 — переход на летнее время.
        const night = new Date("2026-03-29T01:00:00Z");

        expect(hourOf(nextAllowedPingTime(night))).toBe(10);
    });

    /** Результат всегда пригоден для отправки — иначе перенос был бы бессмысленным. */
    it("never returns a moment that is itself quiet", () => {
        for (let hour = 0; hour < 24; hour++) {
            const at = new Date(Date.UTC(2026, 7, 26, hour, 0, 0));
            expect(isQuietHour(nextAllowedPingTime(at))).toBe(false);
        }
    });
});
