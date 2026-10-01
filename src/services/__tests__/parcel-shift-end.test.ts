import { beforeEach, describe, expect, it, vi } from "vitest";

const shiftFindFirst = vi.fn();
const locationFindUnique = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        workShift: { findFirst: (...a: unknown[]) => shiftFindFirst(...a) },
        location: { findUnique: (...a: unknown[]) => locationFindUnique(...a) },
    },
}));
vi.mock("../nova-poshta-service.js", () => ({ novaPoshtaService: {} }));
vi.mock("../parcel-canonical-read.js", () => ({ parcelCanonicalReadService: {} }));

const { logisticsService } = await import("../logistics-service.js");
const service = logisticsService as unknown as { getShiftEndTime(locationId: string, date: Date): Promise<Date | null> };

// Середа, 30.09.2026 (Київ, UTC+3).
const WEDNESDAY = new Date("2026-09-30T09:00:00.000Z");

beforeEach(() => {
    shiftFindFirst.mockReset().mockResolvedValue(null);
    locationFindUnique.mockReset();
});

// Текстове Location.schedule ніхто не оновлює; години точки живуть у вебаппі.
describe("shift end without a mirrored shift", () => {
    it("takes the closing time from the web app's opening hours, not the stale text", async () => {
        locationFindUnique.mockResolvedValue({
            schedule: "Пн-Пт 10:00-18:00",
            openingHours: [{ dayOfWeek: 3, opens: "14:00", closes: "21:00" }],
        });

        await expect(service.getShiftEndTime("loc-1", WEDNESDAY)).resolves.toEqual(new Date("2026-09-30T18:00:00.000Z"));
    });

    it("moves the close to the next day for a venue open past midnight", async () => {
        locationFindUnique.mockResolvedValue({
            schedule: null,
            openingHours: [{ dayOfWeek: 3, opens: "18:00", closes: "01:00" }],
        });

        await expect(service.getShiftEndTime("loc-1", WEDNESDAY)).resolves.toEqual(new Date("2026-09-30T22:00:00.000Z"));
    });

    it("still falls back to the text schedule when the web app has no hours for the day", async () => {
        locationFindUnique.mockResolvedValue({ schedule: "Пн-Пт 10:00-18:00", openingHours: [] });

        await expect(service.getShiftEndTime("loc-1", WEDNESDAY)).resolves.toEqual(new Date("2026-09-30T15:00:00.000Z"));
    });
});
