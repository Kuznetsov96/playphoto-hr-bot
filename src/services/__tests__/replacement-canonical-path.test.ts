import { beforeEach, describe, expect, it, vi } from "vitest";

const createReplacement = vi.fn();
const resolveCanonicalShift = vi.fn();

vi.mock("../aws-business-client.js", async () => {
    // `AwsBusinessApiError` теж імпортується модулем, що тестується: без
    // нього мок ламає `instanceof` ще до перевірки поведінки.
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

const { startCanonicalReplacement } = await import("../replacement-canonical.js");

beforeEach(() => {
    createReplacement.mockReset();
    resolveCanonicalShift.mockReset();
});

const input = {
    workShiftId: "work-shift-1",
    requesterStaffId: "staff-1",
    requesterTelegramId: "12345",
    locationId: "location-1",
    shiftDate: new Date("2026-08-15T00:00:00.000Z"),
};

describe("startCanonicalReplacement", () => {
    it("creates the request through the canonical backend", async () => {
        resolveCanonicalShift.mockResolvedValue({
            ok: true,
            scheduledShiftPublicId: "shift-uuid",
            employeePublicId: "emp-uuid",
        });
        createReplacement.mockResolvedValue({ publicId: "req-uuid", status: "ACTIVE" });

        await expect(startCanonicalReplacement(input)).resolves.toEqual({
            ok: true,
            replacementPublicId: "req-uuid",
        });
        expect(createReplacement).toHaveBeenCalledWith({
            scheduledShiftPublicId: "shift-uuid",
            requesterEmployeePublicId: "emp-uuid",
            requesterTelegramId: "12345",
        });
    });

    it("does not fall back to legacy when the backend fails", async () => {
        resolveCanonicalShift.mockResolvedValue({
            ok: true,
            scheduledShiftPublicId: "shift-uuid",
            employeePublicId: "emp-uuid",
        });
        createReplacement.mockRejectedValue(new Error("HTTP 503"));

        await expect(startCanonicalReplacement(input)).resolves.toEqual({
            ok: false,
            reasonCode: "CANONICAL_BACKEND_UNAVAILABLE",
        });
    });

    it("reports the resolver reason when the shift cannot be resolved", async () => {
        resolveCanonicalShift.mockResolvedValue({ ok: false, reasonCode: "AMBIGUOUS_SHIFT" });

        await expect(startCanonicalReplacement(input)).resolves.toEqual({
            ok: false,
            reasonCode: "AMBIGUOUS_SHIFT",
        });
        expect(createReplacement).not.toHaveBeenCalled();
    });
});
