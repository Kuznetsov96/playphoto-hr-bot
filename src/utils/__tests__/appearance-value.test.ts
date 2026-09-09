import { describe, expect, it } from "vitest";

import { appearanceNeedsReview, stripLegacyLocationSuffix } from "../appearance-value.js";

describe("stripLegacyLocationSuffix", () => {
    it("removes the legacy multi-location suffix", () => {
        expect(stripLegacyLocationSuffix("Без особливостей\n(Обрані локації: Volkland, Smile Park)"))
            .toBe("Без особливостей");
    });

    it("keeps a real appearance description that follows the suffix format loosely", () => {
        expect(stripLegacyLocationSuffix("Тату на передпліччі")).toBe("Тату на передпліччі");
    });

    it("handles empty values", () => {
        expect(stripLegacyLocationSuffix(null)).toBe("");
        expect(stripLegacyLocationSuffix(undefined)).toBe("");
        expect(stripLegacyLocationSuffix("")).toBe("");
    });
});

describe("appearanceNeedsReview", () => {
    it("does not send a clean candidate to review just for picking several locations", () => {
        // Головний регрес: до 09.09.2026 цей рядок означав MANUAL_REVIEW.
        expect(appearanceNeedsReview("Без особливостей\n(Обрані локації: Volkland, Smile Park)"))
            .toBe(false);
    });

    it("still sends real appearance answers to review", () => {
        expect(appearanceNeedsReview("Тату на передпліччі")).toBe(true);
        expect(appearanceNeedsReview("[Фото]")).toBe(true);
        expect(appearanceNeedsReview("[Фото]\n(Обрані локації: Volkland)")).toBe(true);
    });

    it("treats a clean answer as not needing review", () => {
        expect(appearanceNeedsReview("Без особливостей")).toBe(false);
    });

    it("treats an empty value as not needing review", () => {
        expect(appearanceNeedsReview(null)).toBe(false);
        expect(appearanceNeedsReview("")).toBe(false);
    });
});
