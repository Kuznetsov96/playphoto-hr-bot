import { describe, expect, it } from "vitest";

import { MAX_CANDIDATE_AGE, MIN_CANDIDATE_AGE, getAgeRejection, getCandidateAgeRange } from "../candidate-age.js";

/**
 * Локація, яка до 09.09.2026 мала власні межі 16–28. Виняток прибрано —
 * тест лишається, щоб він не повернувся непоміченим.
 */
const volkland2Zaporizhzhia = {
    city: "Запоріжжя",
    name: "Volkland (Шевчик)",
    legacyName: "Volkland 2 (Шевчик)",
    sheet: "Volkland 2",
};

describe("candidate age rules", () => {
    it("uses the 17-26 age range", () => {
        expect(getAgeRejection(16)).toBe("UNDERAGE");
        expect(getAgeRejection(17)).toBeNull();
        expect(getAgeRejection(26)).toBeNull();
        expect(getAgeRejection(27)).toBe("AGE_LIMIT");
    });

    it("exposes the range as constants so copy and logic cannot drift", () => {
        expect(MIN_CANDIDATE_AGE).toBe(17);
        expect(MAX_CANDIDATE_AGE).toBe(26);
        expect(getCandidateAgeRange()).toEqual({ min: 17, max: 26 });
    });

    it("gives Volkland 2 in Zaporizhzhia no special range", () => {
        expect(getCandidateAgeRange(volkland2Zaporizhzhia)).toEqual({ min: 17, max: 26 });
        expect(getAgeRejection(16, volkland2Zaporizhzhia)).toBe("UNDERAGE");
        expect(getAgeRejection(17, volkland2Zaporizhzhia)).toBeNull();
        expect(getAgeRejection(26, volkland2Zaporizhzhia)).toBeNull();
        expect(getAgeRejection(27, volkland2Zaporizhzhia)).toBe("AGE_LIMIT");
    });

    it("applies the same range regardless of city", () => {
        const otherCity = { ...volkland2Zaporizhzhia, city: "Київ" };

        expect(getAgeRejection(16, otherCity)).toBe("UNDERAGE");
        expect(getAgeRejection(17, otherCity)).toBeNull();
        expect(getAgeRejection(27, otherCity)).toBe("AGE_LIMIT");
    });
});
