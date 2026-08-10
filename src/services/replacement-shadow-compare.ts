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
    /**
     * False when `waveName` had no matching wave in the canonical preview at
     * all (as opposed to matching an empty candidate list). Surfaced so a
     * wave-name mismatch between the legacy search and the canonical preview
     * is counted and logged instead of silently read as "canonical found
     * nobody" — those are different failure modes.
     */
    canonicalWaveFound: boolean;
}

/**
 * Compares the legacy candidates for ONE wave against the canonical preview's
 * matching wave, identified by `waveName`. Comparing a single legacy wave
 * against ALL flattened canonical waves compares mismatched populations —
 * `missingInLegacyCount` ends up large on every run and `parity` becomes
 * structurally unreachable, because most canonical candidates simply belong
 * to a different wave than the one legacy just searched.
 */
export function compareReplacementCandidates(
    legacy: LegacyCandidate[],
    canonicalWaves: CanonicalWave[],
    waveName: string
): CandidateComparison {
    const legacyByEmployee = new Map<string, string>();
    for (const candidate of legacy) {
        if (!candidate.awsEmployeePublicId) continue;
        legacyByEmployee.set(candidate.awsEmployeePublicId, candidate.availabilityKind);
    }

    const matchingWave = canonicalWaves.find((wave) => wave.wave === waveName);
    const canonicalWaveFound = matchingWave !== undefined;

    const canonicalByEmployee = new Map<string, string>();
    if (matchingWave) {
        for (const candidate of matchingWave.candidates) {
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
            canonicalWaveFound &&
            missingInCanonicalCount === 0 &&
            missingInLegacyCount === 0 &&
            limitedOnlyInLegacyCount === 0,
        legacyCount: legacy.length,
        canonicalCount: canonicalByEmployee.size,
        matchedCount,
        missingInCanonicalCount,
        missingInLegacyCount,
        unmappedLegacyCount,
        limitedOnlyInLegacyCount,
        canonicalWaveFound
    };
}
