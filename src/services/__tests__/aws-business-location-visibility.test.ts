import { describe, expect, it } from "vitest";

import { locationSchema } from "../aws-business-client.js";

/**
 * Видимость локации для кандидаток живёт в вебаппе (рычаг владельца) и
 * приезжает в бота обычным снимком локаций.
 *
 * Поле ОБЯЗАНО быть опциональным: снимок разбирается схемой .strict(), бот
 * выкатывается раньше бэкенда, и требовать поле значило бы уронить валидацию
 * всего снимка — вместе с синком расписания, — пока вебапп его не начнёт
 * слать. Ровно тот же приём, что у branch и openingHours.
 */
const baseLocation = {
    publicId: "8f1b0f4e-0000-4000-8000-000000000001",
    canonicalCode: "fantasy-town-cherkasy",
    name: "Fantasy Town",
    city: "Черкаси",
    address: null,
    timezone: "Europe/Kyiv",
};

describe("locationSchema.isHiddenFromCandidates", () => {
    it("принимает снимок без поля: бот выкатывается раньше вебаппа", () => {
        const parsed = locationSchema.parse(baseLocation);

        expect(parsed.isHiddenFromCandidates).toBe(false);
    });

    it("переносит скрытие, когда вебапп его прислал", () => {
        const parsed = locationSchema.parse({ ...baseLocation, isHiddenFromCandidates: true });

        expect(parsed.isHiddenFromCandidates).toBe(true);
    });

    it("переносит явное «показывать»", () => {
        const parsed = locationSchema.parse({ ...baseLocation, isHiddenFromCandidates: false });

        expect(parsed.isHiddenFromCandidates).toBe(false);
    });
});

describe("locationSchema.hiringDeficit", () => {
    it("старый бэкенд без поля — undefined, ёмкость в боте не трогаем", () => {
        expect(locationSchema.parse(baseLocation).hiringDeficit).toBeUndefined();
    });

    it("принимает дефицит из вебаппа", () => {
        expect(locationSchema.parse({ ...baseLocation, hiringDeficit: 2 }).hiringDeficit).toBe(2);
    });

    it("отрицательный дефицит — ошибка контракта", () => {
        expect(() => locationSchema.parse({ ...baseLocation, hiringDeficit: -1 })).toThrow();
    });
});

/**
 * Дані блоку «Твоя робота» (рішення власника 01.10.2026): адреса, години й
 * оплата. Усе optional — бот викочується раніше за вебапп, а схема .strict().
 */
describe("locationSchema: дані блоку «Твоя робота»", () => {
    const { address: _address, ...withoutAddress } = baseLocation;
    const pay = {
        weekdayPercent: 25,
        weekendPercent: 30,
        weekdayPairPercent: 18,
        weekendPairPercent: 0,
        weekdayGuarantee: 500,
        weekendGuarantee: 1000,
    };

    it("приймає знімок без нових полів: адресу й оплату не чіпаємо, годин немає", () => {
        const parsed = locationSchema.parse(withoutAddress);

        expect(parsed.address).toBeUndefined();
        expect(parsed.pay).toBeUndefined();
        expect(parsed.openingHours).toEqual([]);
    });

    it("приймає повний набір у формі контракту й зводить години до однієї форми", () => {
        const parsed = locationSchema.parse({
            ...baseLocation,
            address: "Черкаси, бульв. Шевченка 208",
            openingHours: [
                { weekday: 1, opensAt: "10:00", closesAt: "21:00" },
                { weekday: 6, opensAt: "10:00", closesAt: "22:00" },
            ],
            pay,
        });

        expect(parsed.address).toBe("Черкаси, бульв. Шевченка 208");
        expect(parsed.openingHours).toEqual([
            { dayOfWeek: 1, opens: "10:00", closes: "21:00" },
            { dayOfWeek: 6, opens: "10:00", closes: "22:00" },
        ]);
        expect(parsed.pay).toEqual(pay);
    });

    it("далі приймає години в теперішній формі вебаппа (dayOfWeek/opens/closes)", () => {
        const parsed = locationSchema.parse({
            ...baseLocation,
            openingHours: [{ dayOfWeek: 3, opens: "12:00", closes: "20:00" }],
        });

        expect(parsed.openingHours).toEqual([{ dayOfWeek: 3, opens: "12:00", closes: "20:00" }]);
    });

    it("null у годинах і оплаті — «не задано»", () => {
        const parsed = locationSchema.parse({ ...baseLocation, openingHours: null, pay: null });

        expect(parsed.openingHours).toEqual([]);
        expect(parsed.pay).toBeNull();
    });

    it("неповна оплата — помилка контракту, а не тихий «undefined %»", () => {
        expect(() => locationSchema.parse({ ...baseLocation, pay: { weekdayPercent: 25 } })).toThrow();
    });
});

/**
 * Посилання «на мапі» в анкеті. Правда — картка точки у вебаппі (Location.publicMapsUrl),
 * бот лише переносить. Optional, бо бот викочується раніше за вебапп, а схема .strict().
 */
describe("locationSchema.mapsUrl", () => {
    it("старий вебапп без поля — undefined, посилання в боті не чіпаємо", () => {
        expect(locationSchema.parse(baseLocation).mapsUrl).toBeUndefined();
    });

    it("приймає посилання й явний null", () => {
        const url = "https://maps.app.goo.gl/KoKPu6ZDqgEfdshX8";

        expect(locationSchema.parse({ ...baseLocation, mapsUrl: url }).mapsUrl).toBe(url);
        expect(locationSchema.parse({ ...baseLocation, mapsUrl: null }).mapsUrl).toBeNull();
    });

    it("чуже посилання стає null, а знімок не падає", () => {
        for (const url of ["javascript:alert(1)", "https://evil.example/maps", "http://maps.app.goo.gl/x"]) {
            expect(locationSchema.parse({ ...baseLocation, mapsUrl: url }).mapsUrl).toBeNull();
        }
        const search = "https://www.google.com/maps/search/?api=1&query=%D0%9A%D0%B8%D1%97%D0%B2";
        expect(locationSchema.parse({ ...baseLocation, mapsUrl: search }).mapsUrl).toBe(search);
    });
});
