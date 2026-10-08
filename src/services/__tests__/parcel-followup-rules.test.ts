import { describe, expect, it } from "vitest";
import {
    PARCEL_OVERDUE_MS,
    decideDeliveredParcelAction,
    deliveredEntryData,
    formatSupportDateAgo,
    isSameKyivShiftDay,
    selectOverdueAlert,
    verifyingEntryData,
    type DeliveredParcelFacts,
    type OverdueParcelFacts,
} from "../parcel-followup-rules.js";

// Середа, 07.10.2026, 12:00 за Києвом (UTC+3).
const NOW = new Date("2026-10-07T09:00:00.000Z");
const ms = (offset: number) => new Date(NOW.getTime() + offset);

const delivered = (over: Partial<DeliveredParcelFacts> = {}): DeliveredParcelFacts => ({
    status: "DELIVERED",
    contentPhotoCount: 0,
    responsibleStaffId: null,
    locationId: "loc-1",
    deliveryType: "Address",
    deliveredAt: ms(-60_000),
    claimPromptedAt: null,
    outsidePickupAlertSentAt: null,
    ...over,
});

// 08.10.2026: кур'єрська посилка 3,5 тижні висіла «для всіх» — відповідальна
// з'являлась лише через «Забрати» у відділенні.
describe("decideDeliveredParcelAction — courier", () => {
    it("assigns the parcel when exactly one photographer is on shift", () => {
        expect(decideDeliveredParcelAction(delivered(), 1, NOW)).toEqual({ kind: "assign" });
    });

    it("asks everyone on a shared shift, once per shift day", () => {
        expect(decideDeliveredParcelAction(delivered(), 2, NOW)).toEqual({ kind: "prompt_claim" });
        expect(decideDeliveredParcelAction(delivered({ claimPromptedAt: ms(-2 * 3600_000) }), 2, NOW)).toEqual({ kind: "none" });
    });

    it("asks again on the next shift day if nobody took it", () => {
        const yesterday = ms(-24 * 3600_000);
        expect(decideDeliveredParcelAction(delivered({ claimPromptedAt: yesterday }), 3, NOW)).toEqual({ kind: "prompt_claim" });
    });

    it("stays silent without anyone on shift — the 3-day support signal covers it", () => {
        expect(decideDeliveredParcelAction(delivered(), 0, NOW)).toEqual({ kind: "none" });
    });
});

describe("decideDeliveredParcelAction — handed out by Nova Poshta", () => {
    it("tells support once that nobody picked it up through the bot", () => {
        expect(decideDeliveredParcelAction(delivered({ deliveryType: "Warehouse" }), 0, NOW)).toEqual({ kind: "alert_outside_pickup" });
        expect(decideDeliveredParcelAction(delivered({ deliveryType: "Postomat" }), 2, NOW)).toEqual({ kind: "alert_outside_pickup" });
        expect(
            decideDeliveredParcelAction(delivered({ deliveryType: "Warehouse", outsidePickupAlertSentAt: ms(-1) }), 0, NOW),
        ).toEqual({ kind: "none" });
    });

    it("leaves a parcel already past the threshold to the 3-day signal instead of a second message", () => {
        const old = delivered({ deliveryType: "Warehouse", deliveredAt: ms(-PARCEL_OVERDUE_MS - 1) });
        expect(decideDeliveredParcelAction(old, 0, NOW)).toEqual({ kind: "none" });
    });
});

describe("decideDeliveredParcelAction — not ours to touch", () => {
    it.each([
        ["has photos", { contentPhotoCount: 1 }],
        ["has a responsible photographer", { responsibleStaffId: "staff-1" }],
        ["has no location", { locationId: null }],
        ["is waiting for review", { status: "VERIFYING" as const }],
        ["is completed", { status: "COMPLETED" as const }],
        ["is cancelled", { status: "CANCELLED" as const }],
    ])("does nothing when the parcel %s", (_label, over) => {
        expect(decideDeliveredParcelAction(delivered(over), 1, NOW)).toEqual({ kind: "none" });
        expect(decideDeliveredParcelAction(delivered({ ...over, deliveryType: "Warehouse" }), 1, NOW)).toEqual({ kind: "none" });
    });
});

const overdue = (over: Partial<OverdueParcelFacts> = {}): OverdueParcelFacts => ({
    status: "DELIVERED",
    contentPhotoCount: 0,
    deliveredAt: null,
    verifyingSince: null,
    photoOverdueAlertSentAt: null,
    reviewOverdueAlertSentAt: null,
    ...over,
});

describe("selectOverdueAlert", () => {
    it("flags a parcel without content photos only after more than 3 days", () => {
        expect(selectOverdueAlert(overdue({ deliveredAt: ms(-PARCEL_OVERDUE_MS) }), NOW)).toBeNull();
        expect(selectOverdueAlert(overdue({ deliveredAt: ms(-PARCEL_OVERDUE_MS - 1) }), NOW)).toBe("PHOTO_OVERDUE");
    });

    it("flags photos waiting for review only after more than 3 days", () => {
        const verifying = { status: "VERIFYING" as const, contentPhotoCount: 2 };
        expect(selectOverdueAlert(overdue({ ...verifying, verifyingSince: ms(-PARCEL_OVERDUE_MS) }), NOW)).toBeNull();
        expect(selectOverdueAlert(overdue({ ...verifying, verifyingSince: ms(-PARCEL_OVERDUE_MS - 1) }), NOW)).toBe("REVIEW_OVERDUE");
    });

    it("sends each signal once", () => {
        const old = ms(-10 * 24 * 3600_000);
        expect(selectOverdueAlert(overdue({ deliveredAt: old, photoOverdueAlertSentAt: ms(-1) }), NOW)).toBeNull();
        expect(
            selectOverdueAlert(overdue({ status: "VERIFYING", verifyingSince: old, reviewOverdueAlertSentAt: ms(-1) }), NOW),
        ).toBeNull();
    });

    it("ignores delivered parcels that already have photos, closed parcels and missing timestamps", () => {
        const old = ms(-10 * 24 * 3600_000);
        expect(selectOverdueAlert(overdue({ deliveredAt: old, contentPhotoCount: 1 }), NOW)).toBeNull();
        expect(selectOverdueAlert(overdue({ status: "COMPLETED", deliveredAt: old, verifyingSince: old }), NOW)).toBeNull();
        expect(selectOverdueAlert(overdue({ status: "CANCELLED", deliveredAt: old, verifyingSince: old }), NOW)).toBeNull();
        expect(selectOverdueAlert(overdue({ deliveredAt: null }), NOW)).toBeNull();
    });
});

describe("status entry timestamps", () => {
    it("start the clock on entering DELIVERED and reset its one-off signals", () => {
        expect(deliveredEntryData("ARRIVED", NOW)).toEqual({
            deliveredAt: NOW,
            claimPromptedAt: null,
            outsidePickupAlertSentAt: null,
            photoOverdueAlertSentAt: null,
        });
    });

    it("do not move the clock when the parcel is marked DELIVERED again", () => {
        expect(deliveredEntryData("DELIVERED", NOW)).toEqual({});
    });

    it("start the review clock on entering VERIFYING, not on extra photos", () => {
        expect(verifyingEntryData("DELIVERED", NOW)).toEqual({ verifyingSince: NOW, reviewOverdueAlertSentAt: null });
        expect(verifyingEntryData("VERIFYING", NOW)).toEqual({});
    });
});

describe("Kyiv shift day", () => {
    it("treats 20:00 Kyiv as the start of tomorrow's shift", () => {
        const morning = new Date("2026-10-07T06:00:00.000Z"); // 09:00
        const evening = new Date("2026-10-07T17:30:00.000Z"); // 20:30
        const nextMorning = new Date("2026-10-08T06:00:00.000Z");
        expect(isSameKyivShiftDay(morning, NOW)).toBe(true);
        expect(isSameKyivShiftDay(evening, NOW)).toBe(false);
        expect(isSameKyivShiftDay(evening, nextMorning)).toBe(true);
    });
});

describe("formatSupportDateAgo", () => {
    it("names the date in Kyiv and how long ago it was", () => {
        expect(formatSupportDateAgo(new Date("2026-10-04T08:00:00.000Z"), NOW)).toBe("4 Oct 2026 (3 days ago)");
        expect(formatSupportDateAgo(new Date("2026-10-06T08:00:00.000Z"), NOW)).toBe("6 Oct 2026 (1 day ago)");
        expect(formatSupportDateAgo(new Date("2026-10-07T08:00:00.000Z"), NOW)).toBe("7 Oct 2026 (today)");
    });
});
