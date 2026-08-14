import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const requestUpdate = vi.fn();
const queueAdd = vi.fn();
const dispatchCanonicalWave = vi.fn();
const findCandidatesForWave = vi.fn();

vi.mock("../../db/core.js", () => ({
    default: {
        replacementRequest: {
            findUnique: (...a: unknown[]) => findUnique(...a),
            update: (...a: unknown[]) => requestUpdate(...a),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        replacementResponse: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([]),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        // The shift still exists and still belongs to the requester, so the
        // request is not obsolete — otherwise dispatch closes it before ever
        // reaching the routing decision under test.
        workShift: {
            findFirst: vi.fn().mockResolvedValue({ id: "shift-1", staffId: "staff-1", locationId: "loc-1" }),
            findUnique: vi.fn().mockResolvedValue({ id: "shift-1", staffId: "staff-1", locationId: "loc-1" }),
        },
        // Only the local path reaches this: it derives its wave sequence from how
        // many venues the city has. The canonical path never asks.
        location: { count: vi.fn().mockResolvedValue(1) },
        staffProfile: { findMany: vi.fn().mockResolvedValue([]) },
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

const shiftDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

const requestRow = (awsReplacementPublicId: string | null) => ({
    id: "req-local-1",
    awsReplacementPublicId,
    status: "ACTIVE",
    workShiftId: "shift-1",
    requesterStaffId: "staff-1",
    replacementStaffId: null,
    locationId: "loc-1",
    city: "Kyiv",
    shiftDate,
    shiftStartTime: shiftDate,
    shiftEndTime: new Date(shiftDate.getTime() + 7 * 60 * 60 * 1000),
    currentWave: null,
    nextWaveAt: null,
    location: { id: "loc-1", name: "Smile Park", city: "Kyiv", branch: "Troieshchyna", schedule: null },
    requester: { id: "staff-1", fullName: "Тест", user: { telegramId: 1n } },
    replacement: null,
});

beforeEach(() => {
    findUnique.mockReset();
    requestUpdate.mockReset().mockResolvedValue({});
    queueAdd.mockReset().mockResolvedValue(undefined);
    dispatchCanonicalWave.mockReset();
    findCandidatesForWave.mockReset();
    vi.restoreAllMocks();
});

/**
 * Both selectors exist in the codebase during the switchover, and running the
 * wrong one is the failure that matters: the backend would record offers nobody
 * was sent, or the bot would message photographers the backend never chose.
 *
 * `awsReplacementPublicId` is the discriminator. Requests created before the
 * switchover have none and must keep finishing on the local path — cancelling
 * them mid-search would strand photographers who are already deciding.
 */
describe("dispatchNextWave routing", () => {
    it("hands a canonical request to the backend instead of selecting locally", async () => {
        findUnique.mockResolvedValue(requestRow("aws-req-1"));
        dispatchCanonicalWave.mockResolvedValue({
            ok: true,
            status: "ACTIVE",
            nextWaveAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const localSelection = vi.spyOn(replacementService as unknown as { findCandidatesForWave: () => Promise<unknown[]> }, "findCandidatesForWave").mockResolvedValue([]);

        await replacementService.dispatchNextWave({} as never, "req-local-1");

        expect(dispatchCanonicalWave).toHaveBeenCalledWith("aws-req-1");
        expect(localSelection).not.toHaveBeenCalled();
    });

    it("keeps a pre-switchover request on the local path", async () => {
        findUnique.mockResolvedValue(requestRow(null));
        const localSelection = vi.spyOn(replacementService as unknown as { findCandidatesForWave: () => Promise<unknown[]> }, "findCandidatesForWave").mockResolvedValue([]);

        await replacementService.dispatchNextWave({} as never, "req-local-1");

        expect(dispatchCanonicalWave).not.toHaveBeenCalled();
        expect(localSelection).toHaveBeenCalled();
    });

    /**
     * The backend paces the waves, so the next poll is scheduled from the time
     * it reported rather than from a local interval — two clocks disagreeing
     * about when a wave is due is how a request either stalls or gets polled
     * in a tight loop.
     */
    it("schedules the next poll for when the backend said the wave is due", async () => {
        const dueAt = new Date(Date.now() + 45 * 60 * 1000);
        findUnique.mockResolvedValue(requestRow("aws-req-1"));
        dispatchCanonicalWave.mockResolvedValue({ ok: true, status: "ACTIVE", nextWaveAt: dueAt });
        vi.spyOn(replacementService as unknown as { findCandidatesForWave: () => Promise<unknown[]> }, "findCandidatesForWave").mockResolvedValue([]);

        await replacementService.dispatchNextWave({} as never, "req-local-1");

        expect(queueAdd).toHaveBeenCalledWith(
            "replacement-dispatch-wave",
            { requestId: "req-local-1" },
            expect.objectContaining({ delay: expect.any(Number) }),
        );
        const delay = (queueAdd.mock.calls[0]![2] as { delay: number }).delay;
        expect(delay).toBeGreaterThan(30 * 60 * 1000);
    });

    /**
     * Once the backend stops pacing a request — found, cancelled, expired — the
     * bot must stop polling it, or a dead request keeps a job alive for the life
     * of the process.
     */
    it("stops polling once the backend reports no further wave", async () => {
        findUnique.mockResolvedValue(requestRow("aws-req-1"));
        dispatchCanonicalWave.mockResolvedValue({ ok: true, status: "CONFIRMED", nextWaveAt: null });
        vi.spyOn(replacementService as unknown as { findCandidatesForWave: () => Promise<unknown[]> }, "findCandidatesForWave").mockResolvedValue([]);

        await replacementService.dispatchNextWave({} as never, "req-local-1");

        expect(queueAdd).not.toHaveBeenCalled();
    });

    /**
     * An outage must leave the request retryable on the canonical path, never
     * silently hand it to the local selector — that would offer the shift to
     * people the backend has no record of.
     */
    it("retries canonically after an outage rather than falling back to local selection", async () => {
        findUnique.mockResolvedValue(requestRow("aws-req-1"));
        dispatchCanonicalWave.mockResolvedValue({ ok: false, reasonCode: "CANONICAL_BACKEND_UNAVAILABLE" });
        const localSelection = vi.spyOn(replacementService as unknown as { findCandidatesForWave: () => Promise<unknown[]> }, "findCandidatesForWave").mockResolvedValue([]);

        await replacementService.dispatchNextWave({} as never, "req-local-1");

        expect(localSelection).not.toHaveBeenCalled();
        expect(queueAdd).toHaveBeenCalled();
    });
});
