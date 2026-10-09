/**
 * Копія FOUND після відкату в вебаппі (Dragon Park, 04–08.10.2026).
 *
 * Власник скасував прийняту підміну, вебапп повернув заявку в ACTIVE і за
 * 2,5 хвилини закрив FAILED, а копія бота лишилась FOUND назавжди: «Мій
 * графік» прийнятої писав «✅ підміна підтверджена», вранці 08.10 бот сказав
 * їй «сьогодні у тебе зміна», а авторка так і не дізналась, що пошук скінчився.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();
const staffFindFirst = vi.fn();
const queueAdd = vi.fn();
const dispatchCanonicalWave = vi.fn();
const workShiftFindFirst = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        replacementRequest: {
            findUnique: (...a: unknown[]) => findUnique(...a),
            findMany: (...a: unknown[]) => findMany(...a),
            update: vi.fn().mockResolvedValue({}),
            updateMany: (...a: unknown[]) => updateMany(...a),
        },
        replacementResponse: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        workShift: {
            findFirst: (...a: unknown[]) => workShiftFindFirst(...a),
        },
        staffProfile: { findFirst: (...a: unknown[]) => staffFindFirst(...a) },
    },
}));
vi.mock("../../core/queue.js", () => ({
    defaultQueue: { add: (...a: unknown[]) => queueAdd(...a) },
    QUEUES: { DEFAULT: "default" },
}));
const reassignShiftTasks = vi.fn();
vi.mock("../task-service.js", () => ({
    taskService: { reassignShiftTasks: (...a: unknown[]) => reassignShiftTasks(...a) },
}));
vi.mock("../replacement-canonical.js", () => ({
    startCanonicalReplacement: vi.fn(),
    dispatchCanonicalWave: (...a: unknown[]) => dispatchCanonicalWave(...a),
}));

const { replacementService } = await import("../replacement-service.js");

const DAY_MS = 24 * 60 * 60 * 1000;

const requestRow = (shiftDate: Date = new Date(Date.now() + 3 * DAY_MS)) => ({
    id: "req-local-1",
    awsReplacementPublicId: "aws-req-1",
    status: "ACTIVE",
    scheduledShiftPublicId: "canonical-shift-1",
    requesterStaffId: "staff-1",
    replacementStaffId: null,
    locationId: "loc-1",
    city: "Lviv",
    shiftDate,
    shiftStartTime: new Date(shiftDate.getTime() + 11 * 60 * 60 * 1000),
    shiftEndTime: new Date(shiftDate.getTime() + 18 * 60 * 60 * 1000),
    currentWave: null,
    nextWaveAt: null,
    location: { id: "loc-1", name: "Dragon Park 2", city: "Lviv", branch: null, schedule: null },
    requester: { id: "staff-1", fullName: "Мінько Тетяна", user: { telegramId: 100n } },
    replacement: null,
});

const api = () => ({ sendMessage: vi.fn().mockResolvedValue({}) });

beforeEach(() => {
    findUnique.mockReset();
    findMany.mockReset();
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    staffFindFirst.mockReset().mockResolvedValue(null);
    reassignShiftTasks.mockReset().mockResolvedValue(0);
    queueAdd.mockReset().mockResolvedValue(undefined);
    dispatchCanonicalWave.mockReset();
    // Дзеркало вже не містить зміни авторки — саме так виглядала заявка після
    // прийняття. Локальна перевірка на цьому закрила б її з хибним текстом.
    workShiftFindFirst.mockReset().mockResolvedValue(null);
});


const foundRow = (shiftDate: Date = new Date(Date.now() + 3 * DAY_MS)) => ({
    ...requestRow(shiftDate),
    status: "FOUND",
    replacementStaffId: "staff-2",
    completedAt: new Date(Date.now() - DAY_MS),
    closedReason: "canonical_confirmed",
    replacement: { id: "staff-2", fullName: "Квлівідзе Екатеріне", user: { telegramId: 200n } },
});

describe("syncCanonicalRequests on a FOUND copy", () => {
    it("also checks FOUND copies of shifts that have not passed", async () => {
        findMany.mockResolvedValue([]);

        await replacementService.syncCanonicalRequests(api() as never);

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                awsReplacementPublicId: { not: null },
                OR: [
                    { status: "ACTIVE" },
                    { status: "FOUND", shiftDate: { gte: expect.any(Date) } },
                ],
            },
        }));
    });

    it("reopens a copy the owner reverted and gives the shift tasks back to the requester", async () => {
        findMany.mockResolvedValue([foundRow()]);
        dispatchCanonicalWave.mockResolvedValue({
            ok: true, status: "ACTIVE", nextWaveAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        });
        const telegram = api();

        const result = await replacementService.syncCanonicalRequests(telegram as never);

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-1", status: "FOUND" },
            data: expect.objectContaining({
                status: "ACTIVE",
                replacementStaffId: null,
                completedAt: null,
                closedReason: null,
            }),
        });
        expect(reassignShiftTasks).toHaveBeenCalledWith(expect.objectContaining({
            fromStaffId: "staff-2",
            toStaffId: "staff-1",
        }));
        // Про скасування обом уже написав вебапп (ACCEPTANCE_REVERTED).
        expect(telegram.sendMessage).not.toHaveBeenCalled();
        expect(result.settled).toBe(1);
    });

    it("closes a reverted copy whose search then failed and tells the requester the shift is hers", async () => {
        findMany.mockResolvedValue([foundRow()]);
        findUnique.mockResolvedValue(foundRow());
        dispatchCanonicalWave.mockResolvedValue({ ok: true, status: "FAILED", nextWaveAt: null });
        const telegram = api();

        await replacementService.syncCanonicalRequests(telegram as never);

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-1", status: "FOUND" },
            data: expect.objectContaining({ status: "FAILED", replacementStaffId: null }),
        });
        expect(reassignShiftTasks).toHaveBeenCalledWith(expect.objectContaining({
            fromStaffId: "staff-2",
            toStaffId: "staff-1",
        }));
        expect(telegram.sendMessage).toHaveBeenCalledWith(
            100,
            expect.stringContaining("Підміну не знайшли — зміна лишається за тобою."),
            expect.anything(),
        );
    });

    it("leaves a still-confirmed copy as it is and only marks it checked", async () => {
        findMany.mockResolvedValue([foundRow()]);
        dispatchCanonicalWave.mockResolvedValue({
            ok: true, status: "CONFIRMED", nextWaveAt: null, acceptedEmployeePublicId: "emp-2",
        });
        staffFindFirst.mockResolvedValue({ id: "staff-2" });
        const telegram = api();

        const result = await replacementService.syncCanonicalRequests(telegram as never);

        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-1", status: "FOUND" },
            data: { updatedAt: expect.any(Date) },
        });
        expect(reassignShiftTasks).not.toHaveBeenCalled();
        expect(telegram.sendMessage).not.toHaveBeenCalled();
        expect(result.settled).toBe(0);
    });

    it("follows the shift to a different photographer when the search was taken again", async () => {
        findMany.mockResolvedValue([foundRow()]);
        dispatchCanonicalWave.mockResolvedValue({
            ok: true, status: "CONFIRMED", nextWaveAt: null, acceptedEmployeePublicId: "emp-3",
        });
        staffFindFirst.mockResolvedValue({ id: "staff-3" });

        await replacementService.syncCanonicalRequests(api() as never);

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-1", status: "FOUND", replacementStaffId: "staff-2" },
            data: { replacementStaffId: "staff-3" },
        });
        expect(reassignShiftTasks).toHaveBeenCalledWith(expect.objectContaining({
            fromStaffId: "staff-2",
            toStaffId: "staff-3",
        }));
    });
});

describe("syncCanonicalRequest (one request, right after a revert or undo)", () => {
    it("reopens the local copy at once instead of waiting for the five-minute sweep", async () => {
        findMany.mockResolvedValue([foundRow()]);
        dispatchCanonicalWave.mockResolvedValue({
            ok: true, status: "ACTIVE", nextWaveAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
        });

        await replacementService.syncCanonicalRequest(api() as never, "aws-req-1");

        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { awsReplacementPublicId: "aws-req-1", status: { in: ["ACTIVE", "FOUND"] } },
        }));
        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: "req-local-1", status: "FOUND" },
            data: expect.objectContaining({ status: "ACTIVE" }),
        }));
    });

    it("does nothing when the bot has no copy of the request", async () => {
        findMany.mockResolvedValue([]);

        await replacementService.syncCanonicalRequest(api() as never, "aws-unknown");

        expect(dispatchCanonicalWave).not.toHaveBeenCalled();
    });
});
