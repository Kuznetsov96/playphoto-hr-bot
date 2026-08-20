import { describe, expect, it } from "vitest";
import { CanonicalScheduleReadError, projectCanonicalSchedule } from "../aws-schedule-canonical-projector.js";

const canonicalShift = {
    publicId: "33333333-3333-4333-8333-333333333333",
    locationPublicId: "11111111-1111-4111-8111-111111111111",
    localDate: "2026-08-10",
    startsAt: "2026-08-10T08:00:00.000Z",
    endsAt: "2026-08-10T17:00:00.000Z"
};

const location = {
    id: "local-location",
    awsPublicId: canonicalShift.locationPublicId,
    name: "Canonical location mapping",
    city: "Запоріжжя",
    branch: "Shevchyk",
    schedule: "10:00-20:00",
    openingHours: [{ dayOfWeek: 1, opens: "14:00", closes: "21:00" }]
};

const projection = {
    id: "local-shift",
    awsScheduledShiftPublicId: canonicalShift.publicId
};

describe("projectCanonicalSchedule", () => {
    it("uses canonical business fields while preserving local technical identities", () => {
        expect(projectCanonicalSchedule("staff-1", [canonicalShift], [location], [projection])).toEqual([{
            id: projection.id,
            staffId: "staff-1",
            locationId: location.id,
            date: new Date("2026-08-10T00:00:00.000Z"),
            startTime: new Date(canonicalShift.startsAt),
            endTime: new Date(canonicalShift.endsAt),
            location: {
                id: location.id,
                name: location.name,
                city: location.city,
                branch: location.branch,
                schedule: location.schedule,
                openingHours: location.openingHours
            }
        }]);
    });

    /**
     * Зміна, якої ще немає в дзеркалі, пропускається — а не роняє весь список.
     *
     * Дзеркало наздоганяє канон раз на пʼять хвилин, тож одразу після правки
     * графіка у вебі нова зміна вже є в каноні, але проєкції ще немає. Раніше це
     * кидало помилку, читання падало у fallback на дзеркало, і фотографиня бачила
     * СТАРИЙ графік — саме той випадок, коли сповіщення називало 22.08, а список
     * під ним її не містив.
     *
     * Пропуск точніший за fallback: решта змін приходить із канону, тобто свіжа,
     * і зникає лише той рядок, якого дзеркало ще не бачило.
     */
    it("skips a shift the mirror has not caught up with instead of failing the whole read", () => {
        expect(projectCanonicalSchedule("staff-1", [canonicalShift], [location], [])).toEqual([]);
    });

    it("keeps the shifts it can project when only one is missing from the mirror", () => {
        const secondShift = {
            ...canonicalShift,
            publicId: "44444444-4444-4444-8444-444444444444",
            localDate: "2026-08-11",
            startsAt: "2026-08-11T08:00:00.000Z",
            endsAt: "2026-08-11T17:00:00.000Z"
        };

        const projected = projectCanonicalSchedule(
            "staff-1",
            [canonicalShift, secondShift],
            [location],
            [projection]
        );

        expect(projected).toHaveLength(1);
        expect(projected[0]!.id).toBe("local-shift");
    });

    /**
     * Локація — інша річ. Її мапінг не залежить від щойно зробленої правки: він
     * або налаштований, або ні. Показати графік без локації означало б сказати
     * фотографині «зміна є», не назвавши куди йти, тож тут падіння лишається.
     */
    it("still refuses a partial location mapping, which is a configuration gap, not a lag", () => {
        expect(() => projectCanonicalSchedule("staff-1", [canonicalShift], [], [projection]))
            .toThrowError(new CanonicalScheduleReadError("LOCATION_NOT_MAPPED"));
    });
});
