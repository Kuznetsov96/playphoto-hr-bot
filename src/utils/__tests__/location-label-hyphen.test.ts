import { describe, expect, it } from "vitest";

import { formatLocation, normalizeCity } from "../location-label.js";

describe("normalizeCity keeps hyphens", () => {
    it("Ivano-Frankivsk не склеивается в IvanoFrankivsk", () => {
        expect(normalizeCity("Ivano-Frankivsk")).toBe("Ivano-Frankivsk");
        expect(normalizeCity("🏰 Ivano-Frankivsk")).toBe("Ivano-Frankivsk");
    });

    it("город в подписи точки тоже с дефисом", () => {
        expect(formatLocation({ name: "Fly Kids", city: "Ivano-Frankivsk", branch: null } as never, "listing"))
            .toBe("Fly Kids (Ivano-Frankivsk)");
    });
});
