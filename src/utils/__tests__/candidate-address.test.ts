import { describe, expect, it } from "vitest";

import { buildLocationSelectionText, formatCandidateAddress } from "../candidate-address.js";

/**
 * Рядок адреси на екрані вибору точки (25.11.2026). Кейси — адреси всіх 16
 * точок, які анкета показувала кандидаткам на проді того дня.
 */
describe("formatCandidateAddress", () => {
    const prod: Array<[city: string, cityUk: string, address: string, expected: string]> = [
        ["Kharkiv", "Харків", "Харків, вул. Григорія Сковороди, 2а, ТРЦ «Nikolsky»", "вул. Григорія Сковороди, 2а, ТРЦ «Nikolsky»"],
        ["Khmelnytskyi", "Хмельницький", "Хмельницький, проспект Миру, 99/101", "проспект Миру, 99/101"],
        ["Kolomyia", "Коломия", "Коломия, вул. Валова, 48 (ТЦ Прут)", "вул. Валова, 48 (ТЦ Прут)"],
        ["Kyiv", "Київ", "Київ, вул. Петра Вершигори, 1 (ТЦ «Дніпровський»)", "вул. Петра Вершигори, 1 (ТЦ «Дніпровський»)"],
        ["Kyiv", "Київ", "Київ, проспект Степана Бандери, 34-В, РЦ «BLOCKBUSTER», 2 поверх", "проспект Степана Бандери, 34-В, РЦ «BLOCKBUSTER», 2 поверх"],
        ["Kyiv", "Київ", "Київ, вул. Дорошенка, 9, Софіївська Борщагівка", "вул. Дорошенка, 9, Софіївська Борщагівка"],
        ["Kyiv", "Київ", "Київ, вул. Якова Гніздовського, 1а (Маркет-молл \"Даринок\")", "вул. Якова Гніздовського, 1а (Маркет-молл \"Даринок\")"],
        ["Kyiv", "Київ", "Київ, вул. Закревського, 22Т", "вул. Закревського, 22Т"],
        ["Lviv", "Львів", "Львів, вул. Стрийська 202а", "вул. Стрийська 202а"],
        ["Lviv", "Львів", "Львів, вул. Сихівська 16а", "вул. Сихівська 16а"],
        ["Lviv", "Львів", "Львів, вул. Мельника 18", "вул. Мельника 18"],
        ["Lviv", "Львів", "Львів, вул. Під Дубом, 7Б, ТРЦ «Forum Lviv»", "вул. Під Дубом, 7Б, ТРЦ «Forum Lviv»"],
        ["Myrhorod", "Миргород", "вул. Панаса Мирного, 14", "вул. Панаса Мирного, 14"],
        ["Rivne", "Рівне", "Рівне, вул. Київська, 67А (ТЦ \"Арена\")", "вул. Київська, 67А (ТЦ \"Арена\")"],
        ["Sambir", "Самбір", "Самбір, вул. Торгова, 62 (ТЦ «Атлант»)", "вул. Торгова, 62 (ТЦ «Атлант»)"],
        ["Sheptytskyi", "Шептицький", "Шептицький, вул. Богдана Хмельницького, 59", "вул. Богдана Хмельницького, 59"],
    ];

    it.each(prod)("%s: %s", (city, cityUk, address, expected) => {
        expect(formatCandidateAddress(address, city, cityUk)).toBe(expected);
    });

    it("адреса без міста попереду лишається цілою, а не обрізається до номера будинку", () => {
        expect(formatCandidateAddress("вул. Панаса Мирного, 14", "Myrhorod", "Миргород")).toBe("вул. Панаса Мирного, 14");
    });

    it("знімає місто латиницею, з «м.» і без назви з довідника", () => {
        expect(formatCandidateAddress("Kyiv, вул. Закревського, 22Т", "Kyiv", null)).toBe("вул. Закревського, 22Т");
        expect(formatCandidateAddress("м. Київ, вул. Закревського, 22Т", "Kyiv", "Київ")).toBe("вул. Закревського, 22Т");
        expect(formatCandidateAddress("м.Київ, вул. Закревського, 22Т", "Kyiv", "Київ")).toBe("вул. Закревського, 22Т");
        expect(formatCandidateAddress("Київ, вул. Закревського, 22Т", "Kyiv", undefined)).toBe("вул. Закревського, 22Т");
    });

    it("інше місто попереду — не наше, адреса без змін", () => {
        expect(formatCandidateAddress("Софіївська Борщагівка, вул. Дорошенка, 9", "Kyiv", "Київ"))
            .toBe("Софіївська Борщагівка, вул. Дорошенка, 9");
    });

    it("місто з вулиці не знімається: «вул. Київська» в Рівному лишається", () => {
        expect(formatCandidateAddress("вул. Київська, 67А", "Rivne", "Рівне")).toBe("вул. Київська, 67А");
    });

    it("порожня адреса — порожній рядок; адреса з самого міста — як є", () => {
        expect(formatCandidateAddress(null, "Kyiv", "Київ")).toBe("");
        expect(formatCandidateAddress("   ", "Kyiv", "Київ")).toBe("");
        expect(formatCandidateAddress("Київ", "Kyiv", "Київ")).toBe("Київ");
        expect(formatCandidateAddress("Київ,", "Kyiv", "Київ")).toBe("Київ,");
    });

    it("зайві пробіли й переноси згортаються", () => {
        expect(formatCandidateAddress("  Київ ,\n вул.  Закревського,   22Т ", "Kyiv", "Київ")).toBe("вул. Закревського, 22Т");
    });
});

describe("buildLocationSelectionText", () => {
    const name = (l: { name: string; branch?: string | null }) => (l.branch ? `${l.name} (${l.branch})` : l.name);

    it("Київ: повна адреса під кожною точкою, Shark Park — із Софіївською Борщагівкою", () => {
        const text = buildLocationSelectionText("У цьому місті кілька локацій. Оберіть найзручнішу.", [
            { name: "Fly Kids", branch: "Dniprovskyi", city: "Kyiv", cityUk: "Київ", address: "Київ, вул. Петра Вершигори, 1 (ТЦ «Дніпровський»)", googleMapsLink: "https://maps.app.goo.gl/3Dho3m8qAeTf6CaYA" },
            { name: "Shark Park", branch: "Sofiivska Borshchahivka", city: "Kyiv", cityUk: "Київ", address: "Київ, вул. Дорошенка, 9, Софіївська Борщагівка", googleMapsLink: "https://maps.app.goo.gl/KoKPu6ZDqgEfdshX8" },
            { name: "Smile Park", branch: "Darynok", city: "Kyiv", cityUk: "Київ", address: "Київ, вул. Якова Гніздовського, 1а (Маркет-молл \"Даринок\")", googleMapsLink: "https://www.google.com/maps/search/?api=1&query=a%20b" },
        ], name);

        expect(text).toBe(
            "У цьому місті кілька локацій. Оберіть найзручнішу.\n\n"
            + "1. <b>Fly Kids (Dniprovskyi)</b>\n<i>вул. Петра Вершигори, 1 (ТЦ «Дніпровський»)</i> (<a href=\"https://maps.app.goo.gl/3Dho3m8qAeTf6CaYA\">на мапі</a>)\n\n"
            + "2. <b>Shark Park (Sofiivska Borshchahivka)</b>\n<i>вул. Дорошенка, 9, Софіївська Борщагівка</i> (<a href=\"https://maps.app.goo.gl/KoKPu6ZDqgEfdshX8\">на мапі</a>)\n\n"
            + "3. <b>Smile Park (Darynok)</b>\n<i>вул. Якова Гніздовського, 1а (Маркет-молл \"Даринок\")</i> (<a href=\"https://www.google.com/maps/search/?api=1&amp;query=a%20b\">на мапі</a>)\n\n",
        );
    });

    it("точка без мапи й без адреси не лишає порожнього курсиву", () => {
        const text = buildLocationSelectionText("Intro", [
            { name: "Volkland", city: "Myrhorod", cityUk: "Миргород", address: "вул. Панаса Мирного, 14", googleMapsLink: null },
            { name: "Nowhere", city: "Myrhorod", cityUk: "Миргород", address: null, googleMapsLink: "https://maps.app.goo.gl/x" },
            { name: "Empty", city: "Myrhorod", cityUk: "Миргород", address: "", googleMapsLink: null },
        ], name);

        expect(text).toBe(
            "Intro\n\n"
            + "1. <b>Volkland</b>\n<i>вул. Панаса Мирного, 14</i>\n\n"
            + "2. <b>Nowhere</b>\n(<a href=\"https://maps.app.goo.gl/x\">на мапі</a>)\n\n"
            + "3. <b>Empty</b>\n\n",
        );
        expect(text).not.toContain("<i></i>");
    });

    it("HTML у назві й адресі екранується, лапки в посиланні — теж", () => {
        const text = buildLocationSelectionText("I", [
            { name: "A<b>", city: "Kyiv", cityUk: "Київ", address: "Київ, вул. <x> & Co", googleMapsLink: "https://x.y/?q=\"a\"" },
        ], name);
        expect(text).toContain("<b>A&lt;b&gt;</b>");
        expect(text).toContain("<i>вул. &lt;x&gt; &amp; Co</i>");
        expect(text).toContain("href=\"https://x.y/?q=&quot;a&quot;\"");
    });
});
