import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchReplacementWave = vi.fn();

vi.mock("../aws-business-client.js", () => ({
    awsBusinessClient: {
        dispatchReplacementWave: (...a: unknown[]) => dispatchReplacementWave(...a),
    },
    AwsBusinessApiError: class AwsBusinessApiError extends Error {
        constructor(
            public readonly status: number,
            public readonly code: string | undefined,
            message: string,
        ) {
            super(message);
        }
    },
}));

const { dispatchCanonicalWave } = await import("../replacement-canonical.js");
const { AwsBusinessApiError } = await import("../aws-business-client.js");

beforeEach(() => {
    dispatchReplacementWave.mockReset();
});

/**
 * Candidate selection moved to the backend: it owns the wave policy, picks who
 * to ask, and records an OFFER notification for each. The bot's job shrinks to
 * asking "run the next wave" on time and letting the notification dispatcher
 * deliver whatever came out — it no longer decides who gets offered a shift.
 *
 * Running both selectors at once is the thing to avoid: two implementations of
 * the same policy drift, and a photographer offered a shift by one but unknown
 * to the other is exactly the split-brain this migration removes.
 */
describe("dispatchCanonicalWave", () => {
    it("asks the backend to run the next wave and reports when it is due again", async () => {
        dispatchReplacementWave.mockResolvedValue({
            publicId: "req-1",
            status: "ACTIVE",
            nextWaveAt: "2026-08-15T12:00:00.000Z",
        });

        await expect(dispatchCanonicalWave("req-1")).resolves.toEqual({
            ok: true,
            status: "ACTIVE",
            nextWaveAt: new Date("2026-08-15T12:00:00.000Z"),
        });
        expect(dispatchReplacementWave).toHaveBeenCalledWith("req-1");
    });

    /**
     * The backend paces the waves, so a poll that arrives early is normal
     * traffic rather than a fault. It answers with the time the wave is
     * actually due, which is what the next job should be scheduled for —
     * treating this as an error would either drop the request or spin on it.
     */
    it("treats an early poll as a reschedule, not a failure", async () => {
        dispatchReplacementWave.mockRejectedValue(
            Object.assign(
                new AwsBusinessApiError(409, "REPLACEMENT_WAVE_NOT_DUE", "not due"),
                { nextWaveAt: "2026-08-15T14:30:00.000Z" },
            ),
        );

        await expect(dispatchCanonicalWave("req-1")).resolves.toEqual({
            ok: true,
            status: "ACTIVE",
            nextWaveAt: new Date("2026-08-15T14:30:00.000Z"),
        });
    });

    /**
     * A request the backend has closed — found, cancelled, expired — must stop
     * being polled. Rescheduling it forever would keep a dead request alive in
     * the queue for the life of the process.
     */
    it("stops polling a request the backend has closed", async () => {
        dispatchReplacementWave.mockResolvedValue({
            publicId: "req-1",
            status: "CONFIRMED",
            nextWaveAt: null,
        });

        await expect(dispatchCanonicalWave("req-1")).resolves.toEqual({
            ok: true,
            status: "CONFIRMED",
            nextWaveAt: null,
        });
    });

    /**
     * An outage must not silently fall back to local candidate selection: that
     * would offer the shift to people the backend never recorded, and the two
     * sides would disagree about who was asked. Reporting the failure lets the
     * caller retry the same canonical dispatch later.
     */
    it("reports a backend outage instead of selecting candidates locally", async () => {
        dispatchReplacementWave.mockRejectedValue(new Error("boom"));

        await expect(dispatchCanonicalWave("req-1")).resolves.toEqual({
            ok: false,
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
        });
    });
});
