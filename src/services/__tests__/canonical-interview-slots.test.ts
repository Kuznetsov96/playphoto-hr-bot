import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Переключатель канонических слотов интервью (фаза 2b).
 *
 * Флаг ВЫКЛЮЧЕН: поведение байт-в-байт прежнее — список из локального
 * репозитория, бронь через bookingService, никаких обращений к вебаппу.
 *
 * Флаг ВКЛЮЧЁН: список и бронь идут в канонический API вебаппа, а после
 * успешной брони пишется локальное зеркало слота (write-through), чтобы
 * напоминания 6h/10m/HR и автозавершение продолжали работать нетронутыми.
 */

const listSlots = vi.fn();
const bookSlot = vi.fn();
const releaseSlot = vi.fn();
const findActiveSlots = vi.fn();
const bookInterviewSlotLocal = vi.fn();
const slotFindUnique = vi.fn();
const slotCreate = vi.fn();
const slotUpdate = vi.fn();
const sessionCreate = vi.fn();

function mockModules(flagEnabled: boolean) {
    vi.doMock("../../config.js", () => ({ AWS_RECRUITING_SLOTS_ENABLED: flagEnabled }));
    vi.doMock("../aws-business-client.js", () => ({
        awsBusinessClient: {
            listRecruitingInterviewSlots: listSlots,
            bookRecruitingInterviewSlot: bookSlot,
            releaseRecruitingInterviewSlot: releaseSlot,
        },
    }));
    vi.doMock("../booking-service.js", () => ({
        bookingService: { bookInterviewSlot: bookInterviewSlotLocal },
    }));
    vi.doMock("../../repositories/interview-repository.js", () => ({
        interviewRepository: { findActiveSlots },
    }));
    vi.doMock("../../db/core.js", () => ({
        default: {
            interviewSlot: { findUnique: slotFindUnique, create: slotCreate, update: slotUpdate },
            interviewSession: { create: sessionCreate },
        },
    }));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});

describe("flag OFF: the local flow is untouched", () => {
    beforeEach(() => mockModules(false));

    it("lists free slots from the local repository and never calls the web API", async () => {
        const localSlots = [{ id: "local-1", startTime: new Date("2026-09-01T10:00:00Z") }];
        findActiveSlots.mockResolvedValue(localSlots);

        const { findAvailableInterviewSlots } = await import("../canonical-interview-slots.js");
        await expect(findAvailableInterviewSlots()).resolves.toBe(localSlots);

        expect(listSlots).not.toHaveBeenCalled();
    });

    it("books through bookingService with the same arguments and never calls the web API", async () => {
        const booked = { slot: { id: "local-1" }, googleEvent: {} };
        bookInterviewSlotLocal.mockResolvedValue(booked);

        const { bookInterviewSlot } = await import("../canonical-interview-slots.js");
        await expect(bookInterviewSlot(1164289764, "local-1", "olena")).resolves.toBe(booked);

        expect(bookInterviewSlotLocal).toHaveBeenCalledWith(1164289764, "local-1", "olena");
        expect(bookSlot).not.toHaveBeenCalled();
        expect(slotCreate).not.toHaveBeenCalled();
        expect(sessionCreate).not.toHaveBeenCalled();
    });

    it("release is a no-op", async () => {
        const { releaseCanonicalInterviewSlot } = await import("../canonical-interview-slots.js");
        await releaseCanonicalInterviewSlot(1164289764, "candidate_cancelled");

        expect(releaseSlot).not.toHaveBeenCalled();
    });
});

describe("flag ON: the web API is canonical", () => {
    beforeEach(() => mockModules(true));

    const webSlot = {
        publicId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        startsAt: "2026-09-01T10:00:00.000Z",
        endsAt: "2026-09-01T10:15:00.000Z",
    };

    it("lists free slots from the web API mapped to keyboard buttons", async () => {
        listSlots.mockResolvedValue({ items: [webSlot] });

        const { findAvailableInterviewSlots } = await import("../canonical-interview-slots.js");
        const slots = await findAvailableInterviewSlots();

        expect(slots).toEqual([
            { id: webSlot.publicId, startTime: new Date(webSlot.startsAt) },
        ]);
        expect(findActiveSlots).not.toHaveBeenCalled();
    });

    it("books on the web first, then writes the local mirror slot, then runs the local booking", async () => {
        bookSlot.mockResolvedValue(webSlot);
        slotFindUnique.mockResolvedValue(null);
        sessionCreate.mockResolvedValue({ id: "session-1" });
        slotCreate.mockResolvedValue({ id: "local-mirror-1", isBooked: false });
        const booked = { slot: { id: "local-mirror-1" }, googleEvent: {} };
        bookInterviewSlotLocal.mockResolvedValue(booked);

        const { bookInterviewSlot } = await import("../canonical-interview-slots.js");
        await expect(bookInterviewSlot(1164289764, webSlot.publicId, "olena")).resolves.toBe(booked);

        expect(bookSlot).toHaveBeenCalledWith(webSlot.publicId, "1164289764");
        expect(sessionCreate).toHaveBeenCalledWith({
            data: { startTime: new Date(webSlot.startsAt), endTime: new Date(webSlot.endsAt) },
        });
        expect(slotCreate).toHaveBeenCalledWith({
            data: {
                sessionId: "session-1",
                startTime: new Date(webSlot.startsAt),
                endTime: new Date(webSlot.endsAt),
                webSlotPublicId: webSlot.publicId,
            },
        });
        expect(bookInterviewSlotLocal).toHaveBeenCalledWith(1164289764, "local-mirror-1", "olena");
    });

    it("reuses an existing mirror row instead of creating a duplicate", async () => {
        bookSlot.mockResolvedValue(webSlot);
        slotFindUnique.mockResolvedValue({ id: "local-mirror-1", isBooked: false });
        bookInterviewSlotLocal.mockResolvedValue({ slot: { id: "local-mirror-1" }, googleEvent: {} });

        const { bookInterviewSlot } = await import("../canonical-interview-slots.js");
        await bookInterviewSlot(1164289764, webSlot.publicId, "olena");

        expect(sessionCreate).not.toHaveBeenCalled();
        expect(slotCreate).not.toHaveBeenCalled();
        expect(bookInterviewSlotLocal).toHaveBeenCalledWith(1164289764, "local-mirror-1", "olena");
    });

    it("frees a stale booked mirror row before rebooking — the web slot was FREE, so local state lies", async () => {
        bookSlot.mockResolvedValue(webSlot);
        slotFindUnique.mockResolvedValue({ id: "local-mirror-1", isBooked: true });
        slotUpdate.mockResolvedValue({ id: "local-mirror-1", isBooked: false });
        bookInterviewSlotLocal.mockResolvedValue({ slot: { id: "local-mirror-1" }, googleEvent: {} });

        const { bookInterviewSlot } = await import("../canonical-interview-slots.js");
        await bookInterviewSlot(1164289764, webSlot.publicId, "olena");

        expect(slotUpdate).toHaveBeenCalledWith({
            where: { id: "local-mirror-1" },
            data: { isBooked: false, candidate: { disconnect: true }, googleEventId: null },
        });
        expect(bookInterviewSlotLocal).toHaveBeenCalledWith(1164289764, "local-mirror-1", "olena");
    });

    it("on a web booking failure nothing local is written", async () => {
        const taken = Object.assign(new Error("HTTP 409"), { status: 409, code: "RECRUITING_SLOT_TAKEN" });
        bookSlot.mockRejectedValue(taken);

        const { bookInterviewSlot } = await import("../canonical-interview-slots.js");
        await expect(bookInterviewSlot(1164289764, webSlot.publicId, "olena")).rejects.toBe(taken);

        expect(bookInterviewSlotLocal).not.toHaveBeenCalled();
        expect(slotCreate).not.toHaveBeenCalled();
        expect(sessionCreate).not.toHaveBeenCalled();
    });

    it("release calls the web API with the telegramId as digits and the reason", async () => {
        releaseSlot.mockResolvedValue({ released: true });

        const { releaseCanonicalInterviewSlot } = await import("../canonical-interview-slots.js");
        await releaseCanonicalInterviewSlot(1164289764, "candidate_withdrew");

        expect(releaseSlot).toHaveBeenCalledWith("1164289764", "candidate_withdrew");
    });
});
