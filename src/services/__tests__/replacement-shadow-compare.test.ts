import { describe, expect, it } from "vitest";
import { compareReplacementCandidates } from "../replacement-shadow-compare.js";

describe("compareReplacementCandidates", () => {
    it("reports parity when both sides pick the same employees for the searched wave", () => {
        expect(
            compareReplacementCandidates(
                [{ awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }],
                [
                    {
                        wave: "SAME_LOCATION_AVAILABLE",
                        candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                    }
                ],
                "SAME_LOCATION_AVAILABLE"
            )
        ).toEqual({
            parity: true,
            legacyCount: 1,
            canonicalCount: 1,
            matchedCount: 1,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 0,
            unmappedLegacyCount: 0,
            limitedOnlyInLegacyCount: 0,
            canonicalWaveFound: true
        });
    });

    it("counts a legacy LIMITED candidate the canonical side does not restrict", () => {
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: "emp-1", availabilityKind: "LIMITED" }],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                }
            ],
            "SAME_LOCATION_AVAILABLE"
        );
        expect(result.limitedOnlyInLegacyCount).toBe(1);
        expect(result.matchedCount).toBe(1);
        expect(result.parity).toBe(false);
    });

    it("counts employees present on only one side of the same wave", () => {
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-2", availabilityKind: "AVAILABLE" }]
                }
            ],
            "SAME_LOCATION_AVAILABLE"
        );
        expect(result.missingInCanonicalCount).toBe(1);
        expect(result.missingInLegacyCount).toBe(1);
        expect(result.parity).toBe(false);
    });

    it("counts unmapped legacy candidates separately and excludes them from mismatches", () => {
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: null, availabilityKind: "AVAILABLE" }],
            [{ wave: "SAME_LOCATION_AVAILABLE", candidates: [] }],
            "SAME_LOCATION_AVAILABLE"
        );
        expect(result).toEqual({
            parity: true,
            legacyCount: 1,
            canonicalCount: 0,
            matchedCount: 0,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 0,
            unmappedLegacyCount: 1,
            limitedOnlyInLegacyCount: 0,
            canonicalWaveFound: true
        });
    });

    it("ignores candidates from a canonical wave with a different name", () => {
        // Legacy searched SAME_LOCATION_AVAILABLE; the canonical preview also
        // contains SAME_CITY_AVAILABLE with the same employee. Comparing against
        // the flattened union of every wave (the pre-fix behaviour) would report
        // a spurious match here — only the same-named wave may contribute.
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: []
                },
                {
                    wave: "SAME_CITY_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                }
            ],
            "SAME_LOCATION_AVAILABLE"
        );
        expect(result.canonicalCount).toBe(0);
        expect(result.matchedCount).toBe(0);
        expect(result.missingInCanonicalCount).toBe(1);
        expect(result.parity).toBe(false);
        expect(result.canonicalWaveFound).toBe(true);
    });

    it("reports a wave-name mismatch rather than treating it as an empty canonical set", () => {
        // The canonical preview contains no wave named "SAME_CITY_AVAILABLE" at
        // all — this must be visibly different from a wave that exists but is
        // empty (which is legitimate and should not, on its own, break parity).
        const result = compareReplacementCandidates(
            [],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: []
                }
            ],
            "SAME_CITY_AVAILABLE"
        );
        expect(result.canonicalWaveFound).toBe(false);
        expect(result.parity).toBe(false);
        expect(result.legacyCount).toBe(0);
        expect(result.canonicalCount).toBe(0);
    });

    it("accounts for duplicate legacy entries in unmappedLegacyCount and maintains invariant", () => {
        const result = compareReplacementCandidates(
            [
                { awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" },
                { awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }
            ],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                }
            ],
            "SAME_LOCATION_AVAILABLE"
        );
        expect(result).toEqual({
            parity: true,
            legacyCount: 2,
            canonicalCount: 1,
            matchedCount: 1,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 0,
            unmappedLegacyCount: 1,
            limitedOnlyInLegacyCount: 0,
            canonicalWaveFound: true
        });
        expect(
            result.legacyCount ===
                result.matchedCount + result.missingInCanonicalCount + result.unmappedLegacyCount
        ).toBe(true);
    });
});
