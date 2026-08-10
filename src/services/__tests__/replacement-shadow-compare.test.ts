import { describe, expect, it } from "vitest";
import { compareReplacementCandidates } from "../replacement-shadow-compare.js";

describe("compareReplacementCandidates", () => {
    it("reports parity when both sides pick the same employees", () => {
        expect(
            compareReplacementCandidates(
                [{ awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }],
                [
                    {
                        wave: "SAME_LOCATION_AVAILABLE",
                        candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                    }
                ]
            )
        ).toEqual({
            parity: true,
            legacyCount: 1,
            canonicalCount: 1,
            matchedCount: 1,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 0,
            unmappedLegacyCount: 0,
            limitedOnlyInLegacyCount: 0
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
            ]
        );
        expect(result.limitedOnlyInLegacyCount).toBe(1);
        expect(result.matchedCount).toBe(1);
        expect(result.parity).toBe(false);
    });

    it("counts employees present on only one side", () => {
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-2", availabilityKind: "AVAILABLE" }]
                }
            ]
        );
        expect(result.missingInCanonicalCount).toBe(1);
        expect(result.missingInLegacyCount).toBe(1);
        expect(result.parity).toBe(false);
    });

    it("counts unmapped legacy candidates separately and excludes them from mismatches", () => {
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: null, availabilityKind: "AVAILABLE" }],
            []
        );
        expect(result).toEqual({
            parity: true,
            legacyCount: 1,
            canonicalCount: 0,
            matchedCount: 0,
            missingInCanonicalCount: 0,
            missingInLegacyCount: 0,
            unmappedLegacyCount: 1,
            limitedOnlyInLegacyCount: 0
        });
    });

    it("deduplicates an employee appearing in more than one canonical wave", () => {
        const result = compareReplacementCandidates(
            [{ awsEmployeePublicId: "emp-1", availabilityKind: "AVAILABLE" }],
            [
                {
                    wave: "SAME_LOCATION_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                },
                {
                    wave: "SAME_CITY_AVAILABLE",
                    candidates: [{ employeePublicId: "emp-1", availabilityKind: "AVAILABLE" }]
                }
            ]
        );
        expect(result.canonicalCount).toBe(1);
        expect(result.parity).toBe(true);
    });
});
