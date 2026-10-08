import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn();
const parcelFindUnique = vi.fn();
const parcelFindMany = vi.fn();
const parcelUpdate = vi.fn();
const parcelUpdateMany = vi.fn();
const shiftFindMany = vi.fn();

vi.mock("grammy", async (importOriginal) => {
    const actual = await importOriginal<typeof import("grammy")>();
    class Bot {
        api = { sendMessage: (...a: unknown[]) => sendMessage(...a) };
    }
    return { ...actual, Bot };
});
vi.mock("../../config.js", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    TEAM_CHATS: { SUPPORT: -100, LOGISTICS: 7 },
}));
vi.mock("../../db/core.js", () => ({
    default: {
        parcel: {
            findUnique: (...a: unknown[]) => parcelFindUnique(...a),
            findMany: (...a: unknown[]) => parcelFindMany(...a),
            update: (...a: unknown[]) => parcelUpdate(...a),
            updateMany: (...a: unknown[]) => parcelUpdateMany(...a),
        },
        workShift: { findMany: (...a: unknown[]) => shiftFindMany(...a) },
    },
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { parcelFollowupService } = await import("../parcel-followup-service.js");

// Середа, 07.10.2026, 12:00 за Києвом.
const NOW = new Date("2026-10-07T09:00:00.000Z");
const DAY = 24 * 3600_000;
const location = { name: "Fly Kids", city: "Київ", branch: null };

const parcel = (over: Record<string, unknown> = {}) => ({
    id: "p1",
    ttn: "20451545104740",
    status: "DELIVERED",
    locationId: "loc-1",
    location,
    deliveryType: "Address",
    responsibleStaffId: null,
    responsibleStaff: null,
    contentPhotoIds: [],
    deliveredAt: new Date(NOW.getTime() - 3600_000),
    verifyingSince: null,
    claimPromptedAt: null,
    outsidePickupAlertSentAt: null,
    photoOverdueAlertSentAt: null,
    reviewOverdueAlertSentAt: null,
    ...over,
});

const shiftOf = (staffId: string, telegramId: number) => ({ staffId, staff: { user: { telegramId: BigInt(telegramId) } } });

const callbacks = (call: unknown[]) => JSON.stringify((call[2] as { reply_markup: unknown }).reply_markup);

beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue({});
    parcelFindUnique.mockReset();
    parcelFindMany.mockReset().mockResolvedValue([]);
    parcelUpdate.mockReset().mockResolvedValue({});
    parcelUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    shiftFindMany.mockReset().mockResolvedValue([]);
});

describe("followUpDeliveredParcel — courier delivery", () => {
    it("makes the only photographer on shift responsible and messages her with the photo button", async () => {
        parcelFindUnique.mockResolvedValue(parcel());
        shiftFindMany.mockResolvedValue([shiftOf("staff-1", 111)]);

        await parcelFollowupService.followUpDeliveredParcel("p1", NOW);

        expect(parcelUpdateMany).toHaveBeenCalledWith({
            where: { id: "p1", status: "DELIVERED", responsibleStaffId: null, contentPhotoIds: { isEmpty: true } },
            data: { responsibleStaffId: "staff-1", acceptedAt: NOW, photoReminderSentAt: null, shiftEndReminderSentAt: null },
        });
        expect(sendMessage).toHaveBeenCalledOnce();
        const call = sendMessage.mock.calls[0]!;
        expect(call[0]).toBe(111);
        expect(call[1]).toContain("закріплено за тобою");
        expect(callbacks(call)).toContain("pph");
    });

    it("does not message anyone if someone took the parcel in the meantime", async () => {
        parcelFindUnique.mockResolvedValue(parcel());
        shiftFindMany.mockResolvedValue([shiftOf("staff-1", 111)]);
        parcelUpdateMany.mockResolvedValue({ count: 0 });

        await parcelFollowupService.followUpDeliveredParcel("p1", NOW);

        expect(sendMessage).not.toHaveBeenCalled();
    });

    it("offers the parcel to everyone on a shared shift and remembers it did", async () => {
        parcelFindUnique.mockResolvedValue(parcel());
        shiftFindMany.mockResolvedValue([shiftOf("staff-1", 111), shiftOf("staff-2", 222), shiftOf("staff-1", 111)]);

        await parcelFollowupService.followUpDeliveredParcel("p1", NOW);

        expect(sendMessage.mock.calls.map(call => call[0])).toEqual([111, 222]);
        expect(sendMessage.mock.calls[0]![1]).toContain("хто перша натисне");
        expect(parcelUpdateMany).not.toHaveBeenCalled();
        expect(parcelUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { claimPromptedAt: NOW } });
    });

    it("only asks for active photographers' shifts", async () => {
        parcelFindUnique.mockResolvedValue(parcel());

        await parcelFollowupService.followUpDeliveredParcel("p1", NOW);

        expect(shiftFindMany.mock.calls[0]![0].where.staff).toEqual({ isActive: true });
        expect(sendMessage).not.toHaveBeenCalled();
        expect(parcelUpdate).not.toHaveBeenCalled();
    });
});

describe("followUpDeliveredParcel — handed out by Nova Poshta", () => {
    it("tells support in English, once, with the manage button", async () => {
        parcelFindUnique.mockResolvedValue(parcel({ deliveryType: "Warehouse" }));

        await parcelFollowupService.followUpDeliveredParcel("p1", NOW);

        expect(shiftFindMany).not.toHaveBeenCalled();
        const call = sendMessage.mock.calls[0]!;
        expect(call[0]).toBe(-100);
        expect(call[1]).toContain("nobody picked it up through the bot");
        expect(call[2]).toMatchObject({ message_thread_id: 7 });
        expect(callbacks(call)).toContain("admin_parcel_view_details_p1");
        expect(parcelUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { outsidePickupAlertSentAt: NOW } });
    });

    it("keeps the flag unset when Telegram rejects the message, so the next cycle retries", async () => {
        parcelFindUnique.mockResolvedValue(parcel({ deliveryType: "Warehouse" }));
        sendMessage.mockRejectedValue(new Error("chat not found"));

        await parcelFollowupService.followUpDeliveredParcel("p1", NOW);

        expect(parcelUpdate).not.toHaveBeenCalled();
    });
});

describe("alertOverdueParcels", () => {
    it("selects only unsignalled parcels older than 3 days", async () => {
        await parcelFollowupService.alertOverdueParcels(NOW);

        const threshold = new Date(NOW.getTime() - 3 * DAY);
        expect(parcelFindMany.mock.calls[0]![0].where).toEqual({
            OR: [
                { status: "DELIVERED", contentPhotoIds: { isEmpty: true }, photoOverdueAlertSentAt: null, deliveredAt: { lt: threshold } },
                { status: "VERIFYING", reviewOverdueAlertSentAt: null, verifyingSince: { lt: threshold } },
            ],
        });
    });

    it("tells support a parcel has had no content photos for 3 days and who is responsible", async () => {
        parcelFindMany.mockResolvedValue([parcel({ deliveredAt: new Date(NOW.getTime() - 4 * DAY) })]);

        await parcelFollowupService.alertOverdueParcels(NOW);

        const call = sendMessage.mock.calls[0]!;
        expect(call[1]).toContain("No Content Photos for 3 Days");
        expect(call[1]).toContain("<b>Responsible:</b> nobody");
        expect(call[1]).toContain("(4 days ago)");
        expect(callbacks(call)).toContain("admin_parcel_view_details_p1");
        expect(parcelUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { photoOverdueAlertSentAt: NOW } });
    });

    it("offers the same confirm button as the photo album for photos waiting for review", async () => {
        parcelFindMany.mockResolvedValue([
            parcel({
                status: "VERIFYING",
                contentPhotoIds: ["f1"],
                verifyingSince: new Date(NOW.getTime() - 12 * DAY),
                responsibleStaff: { fullName: "Олена Коваль", user: { username: "olena" } },
            }),
        ]);

        await parcelFollowupService.alertOverdueParcels(NOW);

        const call = sendMessage.mock.calls[0]!;
        expect(call[1]).toContain("Photos Waiting for Review");
        expect(call[1]).toContain("Олена Коваль");
        expect(call[1]).toContain("(12 days ago)");
        expect(callbacks(call)).toContain('"apc_p1"');
        expect(callbacks(call)).toContain("admin_parcel_view_details_p1");
        expect(parcelUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { reviewOverdueAlertSentAt: NOW } });
    });
});
