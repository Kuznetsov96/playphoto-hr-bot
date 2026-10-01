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
    queueAdd.mockReset().mockResolvedValue(undefined);
    dispatchCanonicalWave.mockReset();
    // Дзеркало вже не містить зміни авторки — саме так виглядала заявка після
    // прийняття. Локальна перевірка на цьому закрила б її з хибним текстом.
    workShiftFindFirst.mockReset().mockResolvedValue(null);
});

describe("canonical replacement outcome on the bot's copy", () => {
    // Dragon Park 2, 30.09.2026: бот закрив копію через годину і написав авторці
    // «Пошук закрито. Графік уже оновлено.» про підміну, яку знайшли.
    it("records a confirmed replacement as FOUND without messaging the requester", async () => {
        findUnique.mockResolvedValue(requestRow());
        dispatchCanonicalWave.mockResolvedValue({
            ok: true, status: "CONFIRMED", nextWaveAt: null, acceptedEmployeePublicId: "emp-2",
        });
        staffFindFirst.mockResolvedValue({ id: "staff-2" });
        const telegram = api();

        await replacementService.dispatchNextWave(telegram as never, "req-local-1");

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-1", status: "ACTIVE" },
            data: expect.objectContaining({ status: "FOUND", replacementStaffId: "staff-2" }),
        });
        expect(telegram.sendMessage).not.toHaveBeenCalled();
        expect(queueAdd).not.toHaveBeenCalled();
    });

    // Dragon Park 2, 29.09.2026: вебапп поставив FAILED, бот мовчав, а графік
    // писав «шукаємо підміну».
    it("closes a failed search and tells the requester the shift stays hers", async () => {
        findUnique.mockResolvedValue(requestRow());
        dispatchCanonicalWave.mockResolvedValue({ ok: true, status: "FAILED", nextWaveAt: null });
        const telegram = api();

        await replacementService.dispatchNextWave(telegram as never, "req-local-1");

        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-1", status: "ACTIVE" },
            data: expect.objectContaining({ status: "FAILED" }),
        });
        expect(telegram.sendMessage).toHaveBeenCalledWith(
            100,
            expect.stringContaining("Підміну не знайшли — зміна лишається за тобою."),
            expect.anything(),
        );
    });

    it("does not message anyone about a search that failed for a shift already in the past", async () => {
        findUnique.mockResolvedValue(requestRow(new Date(Date.now() - 2 * DAY_MS)));
        dispatchCanonicalWave.mockResolvedValue({ ok: true, status: "FAILED", nextWaveAt: null });
        const telegram = api();

        await replacementService.dispatchNextWave(telegram as never, "req-local-1");

        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: "FAILED" }),
        }));
        expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it("keeps polling an open search instead of closing it by the local mirror", async () => {
        findUnique.mockResolvedValue(requestRow());
        dispatchCanonicalWave.mockResolvedValue({
            ok: true, status: "ACTIVE", nextWaveAt: new Date(Date.now() + 30 * 60 * 1000),
        });
        const telegram = api();

        await replacementService.dispatchNextWave(telegram as never, "req-local-1");

        expect(updateMany).not.toHaveBeenCalled();
        expect(queueAdd).toHaveBeenCalledWith("replacement-dispatch-wave", { requestId: "req-local-1" }, expect.anything());
        expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
        ["EXPIRED", "EXPIRED"],
        ["CANCELLED", "CANCELLED"],
        ["SUPERSEDED", "CLOSED_BY_SCHEDULE_SYNC"],
    ])("mirrors %s silently as %s", async (canonical, local) => {
        findUnique.mockResolvedValue(requestRow());
        dispatchCanonicalWave.mockResolvedValue({ ok: true, status: canonical, nextWaveAt: null });
        const telegram = api();

        await replacementService.dispatchNextWave(telegram as never, "req-local-1");

        expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: local }),
        }));
        expect(telegram.sendMessage).not.toHaveBeenCalled();
    });
});

describe("syncCanonicalRequests", () => {
    it("settles copies the backend already closed and touches the ones still open", async () => {
        const closed = requestRow();
        const open = { ...requestRow(), id: "req-local-2", awsReplacementPublicId: "aws-req-2" };
        findMany.mockResolvedValue([closed, open]);
        dispatchCanonicalWave.mockImplementation(async (publicId: string) =>
            publicId === "aws-req-1"
                ? { ok: true, status: "SUPERSEDED", nextWaveAt: null }
                : { ok: true, status: "ACTIVE", nextWaveAt: new Date(Date.now() + 60_000) },
        );

        const result = await replacementService.syncCanonicalRequests(api() as never);

        expect(result).toEqual({ checked: 2, settled: 1, failed: 0 });
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { status: "ACTIVE", awsReplacementPublicId: { not: null } },
        }));
        expect(updateMany).toHaveBeenCalledWith({
            where: { id: "req-local-2", status: "ACTIVE" },
            data: { updatedAt: expect.any(Date) },
        });
        // Сверка не запускає власного ланцюжка хвиль — він уже є.
        expect(queueAdd).not.toHaveBeenCalled();
    });

    it("counts a backend outage without closing anything", async () => {
        findMany.mockResolvedValue([requestRow()]);
        dispatchCanonicalWave.mockResolvedValue({ ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" });

        const result = await replacementService.syncCanonicalRequests(api() as never);

        expect(result).toEqual({ checked: 1, settled: 0, failed: 1 });
        expect(updateMany).not.toHaveBeenCalled();
    });
});
