import { describe, expect, it } from "vitest";

import { getAgeRejection, getCandidateAgeRange, isVolkland2Zaporizhzhia } from "../candidate-age.js";

const volkland2Zaporizhzhia = {
    city: "Запоріжжя",
    name: "Volkland (Шевчик)",
    legacyName: "Volkland 2 (Шевчик)",
    sheet: "Volkland 2",
};

describe("candidate age rules", () => {
    it("uses the default 17-26 age range for regular locations", () => {
        expect(getAgeRejection(16)).toBe("UNDERAGE");
        expect(getAgeRejection(17)).toBeNull();
        expect(getAgeRejection(26)).toBeNull();
        expect(getAgeRejection(27)).toBe("AGE_LIMIT");
    });

    it("allows ages 16-28 for Volkland 2 in Zaporizhzhia", () => {
        expect(isVolkland2Zaporizhzhia(volkland2Zaporizhzhia)).toBe(true);
        expect(getCandidateAgeRange(volkland2Zaporizhzhia)).toEqual({ min: 16, max: 28 });
        expect(getAgeRejection(15, volkland2Zaporizhzhia)).toBe("UNDERAGE");
        expect(getAgeRejection(16, volkland2Zaporizhzhia)).toBeNull();
        expect(getAgeRejection(28, volkland2Zaporizhzhia)).toBeNull();
        expect(getAgeRejection(29, volkland2Zaporizhzhia)).toBe("AGE_LIMIT");
    });

    it("does not apply the Volkland 2 range outside Zaporizhzhia", () => {
        const otherCity = { ...volkland2Zaporizhzhia, city: "Київ" };

        expect(isVolkland2Zaporizhzhia(otherCity)).toBe(false);
        expect(getAgeRejection(16, otherCity)).toBe("UNDERAGE");
        expect(getAgeRejection(27, otherCity)).toBe("AGE_LIMIT");
    });
});
