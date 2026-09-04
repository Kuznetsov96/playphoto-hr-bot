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
