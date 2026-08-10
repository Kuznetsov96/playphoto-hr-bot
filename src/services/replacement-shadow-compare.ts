export interface LegacyCandidate {
    awsEmployeePublicId: string | null;
    availabilityKind: string;
}

export interface CanonicalWave {
    wave: string;
    candidates: Array<{ employeePublicId: string; availabilityKind: string }>;
}

export interface CandidateComparison {
    parity: boolean;
    legacyCount: number;
    canonicalCount: number;
    matchedCount: number;
    missingInCanonicalCount: number;
    missingInLegacyCount: number;
    unmappedLegacyCount: number;
    limitedOnlyInLegacyCount: number;
}

export function compareReplacementCandidates(
    legacy: LegacyCandidate[],
    canonicalWaves: CanonicalWave[]
): CandidateComparison {
    const legacyByEmployee = new Map<string, string>();
    for (const candidate of legacy) {
        if (!candidate.awsEmployeePublicId) continue;
        legacyByEmployee.set(candidate.awsEmployeePublicId, candidate.availabilityKind);
    }

    const canonicalByEmployee = new Map<string, string>();
    for (const wave of canonicalWaves) {
        for (const candidate of wave.candidates) {
            if (!canonicalByEmployee.has(candidate.employeePublicId)) {
                canonicalByEmployee.set(candidate.employeePublicId, candidate.availabilityKind);
            }
        }
    }

    let matchedCount = 0;
    let limitedOnlyInLegacyCount = 0;
    for (const [employeePublicId, legacyKind] of legacyByEmployee) {
        const canonicalKind = canonicalByEmployee.get(employeePublicId);
        if (canonicalKind === undefined) continue;
        matchedCount += 1;
        if (legacyKind === "LIMITED" && canonicalKind !== "LIMITED") limitedOnlyInLegacyCount += 1;
    }

    const missingInCanonicalCount = legacyByEmployee.size - matchedCount;
    const missingInLegacyCount = canonicalByEmployee.size - matchedCount;
    // Includes both rows with no employee ID (null awsEmployeePublicId) and rows dropped as duplicates by Map deduplication.
    const unmappedLegacyCount = legacy.length - legacyByEmployee.size;

    return {
        parity:
            missingInCanonicalCount === 0 &&
            missingInLegacyCount === 0 &&
            limitedOnlyInLegacyCount === 0,
        legacyCount: legacy.length,
        canonicalCount: canonicalByEmployee.size,
        matchedCount,
        missingInCanonicalCount,
        missingInLegacyCount,
        unmappedLegacyCount,
        limitedOnlyInLegacyCount
    };
}
