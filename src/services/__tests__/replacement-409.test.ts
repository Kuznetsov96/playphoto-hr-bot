import { beforeEach, describe, expect, it, vi } from "vitest";

const createReplacement = vi.fn();
const resolveCanonicalShift = vi.fn();

vi.mock("../aws-business-client.js", async () => {
    const actual = await vi.importActual<typeof import("../aws-business-client.js")>(
        "../aws-business-client.js"
    );
    return {
        ...actual,
        awsBusinessClient: { createReplacement: (...a: unknown[]) => createReplacement(...a) },
    };
});
vi.mock("../canonical-shift-resolver.js", () => ({
    resolveCanonicalShift: (...a: unknown[]) => resolveCanonicalShift(...a),
}));
vi.mock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn() }));

const { AwsBusinessApiError } = await import("../aws-business-client.js");
const { startCanonicalReplacement } = await import("../replacement-canonical.js");

const INPUT = {
    workShiftId: "w1",
    requesterStaffId: "s1",
    requesterTelegramId: "1",
    locationId: "l1",
    shiftDate: new Date("2026-08-24T00:00:00.000Z"),
};

beforeEach(() => {
    createReplacement.mockReset();
    resolveCanonicalShift.mockResolvedValue({
        ok: true,
        scheduledShiftPublicId: "sh-1",
        employeePublicId: "emp-1",
    });
});

describe("startCanonicalReplacement reason codes", () => {
    /**
     * Діана натиснула «Потрібна підміна» і побачила «Не вдалося створити
     * запит… Спробуй ще раз». Бекенд був доступний і відповів осмислено:
     * заявка на цю зміну вже відкрита. Порада повторити тут марна — повтор
     * упреться в той самий конфлікт, що видно з логів: два натискання поспіль.
     */
    it("keeps an already-open request distinct from a dead backend", async () => {
        createReplacement.mockRejectedValue(
            new AwsBusinessApiError(409, "REPLACEMENT_REQUEST_ALREADY_OPEN", "already open")
        );

        await expect(startCanonicalReplacement(INPUT)).resolves.toMatchObject({
            ok: false,
            reasonCode: "REPLACEMENT_REQUEST_ALREADY_OPEN",
        });
    });

    it("still reports a genuinely unreachable backend as such", async () => {
        createReplacement.mockRejectedValue(new Error("socket hang up"));

        await expect(startCanonicalReplacement(INPUT)).resolves.toMatchObject({
            ok: false,
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
        });
    });

    it("does not mistake another conflict for an open request", async () => {
        createReplacement.mockRejectedValue(
            new AwsBusinessApiError(409, "SCHEDULED_SHIFT_CONFLICT", "other conflict")
        );

        await expect(startCanonicalReplacement(INPUT)).resolves.toMatchObject({
            ok: false,
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
        });
    });
});
