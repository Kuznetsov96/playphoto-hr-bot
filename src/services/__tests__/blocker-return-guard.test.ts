import { describe, expect, it, vi } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { getBlockerReturnDecision, type BlockerReturnCandidate } from "../blocker-return-service.js";
import { getUnderageReactivationDecision } from "../underage-reactivation-service.js";
import {
    buildNextCandidateFunnelState,
    normalizeCandidateFunnelPatch,
    validateCandidateFunnelTransition,
} from "../candidate-funnel-guard.js";

/**
 * Финальное ревью 10.11: patch-и возврата из BLOCKER упирались в funnel guard
 * (INVALID_STATUS_TRANSITION), а юнит-тесты решения guard не запускали.
 */
const open = { neededCount: 2, isHidden: false, isHiddenFromCandidates: false, minAge: null } as never;
const closed = { neededCount: 0, isHidden: false, isHiddenFromCandidates: false, minAge: null } as never;

const base = {
    id: "c1",
    fullName: "Діана",
    status: CandidateStatus.BLOCKER,
    currentStep: FunnelStep.INITIAL_TEST,
    hrDecision: null,
    candidateDecision: null,
    isWaitlisted: false,
    notificationSent: false,
    materialsSent: false,
    interviewCompletedAt: null,
    interviewSlotId: null,
    discoverySlotId: null,
    trainingSlotId: null,
    gender: "female",
    birthDate: new Date("2000-01-01"),
    city: "Львів",
    locationId: "l1",
    appearance: "Без особливостей",
    source: "instagram",
    location: open,
} as unknown as BlockerReturnCandidate;

const cases: Array<[string, Partial<BlockerReturnCandidate> & Record<string, unknown>]> = [
    ["анкета не завершена", { appearance: null, source: null }],
    ["ручний огляд (тату)", { tattooPhotoId: "p1" }],
    ["готова до співбесіди", {}],
    ["waitlist HR (локація закрита)", { location: closed }],
    ["INTERVIEW waitlist", { currentStep: FunnelStep.INTERVIEW }],
    ["ACCEPTED", { hrDecision: "ACCEPTED" }],
    ["REJECTED", { hrDecision: "REJECTED" }],
    ["AGE_LIMIT", { hrDecision: "AGE_LIMIT" }],
    ["NOSHOW", { hrDecision: "NOSHOW" }],
    ["underage дорослішала, анкета не завершена", { hrDecision: "REJECTED_SYSTEM_UNDERAGE", appearance: null, source: null }],
    ["underage дорослішала, готова", { hrDecision: "REJECTED_SYSTEM_UNDERAGE" }],
    ["underage дорослішала, тату", { hrDecision: "REJECTED_SYSTEM_UNDERAGE", tattooPhotoId: "p1" }],
    ["underage дорослішала, локація закрита", { hrDecision: "REJECTED_SYSTEM_UNDERAGE", location: closed }],
    ["underage досі неповнолітня", { hrDecision: "REJECTED_SYSTEM_UNDERAGE", birthDate: new Date(Date.now() - 16 * 365 * 24 * 3600 * 1000) }],
];

describe("повернення з BLOCKER проходить funnel guard", () => {
    it.each(cases)("%s", (_name, override) => {
        const candidate = { ...base, ...override } as BlockerReturnCandidate;
        const decision = getBlockerReturnDecision(candidate);
        expect(decision).not.toBeNull();
        const snapshot = candidate as never;
        expect(() => {
            const patch = normalizeCandidateFunnelPatch(snapshot, decision!.patch);
            validateCandidateFunnelTransition(buildNextCandidateFunnelState(snapshot, patch));
        }).not.toThrow();
    });

    it("guard не відкрив BLOCKER -> довільний статус", () => {
        const snapshot = base as never;
        expect(() => {
            const patch = normalizeCandidateFunnelPatch(snapshot, { status: CandidateStatus.INTERVIEW_SCHEDULED });
            validateCandidateFunnelTransition(buildNextCandidateFunnelState(snapshot, patch));
        }).toThrow();
    });
});

describe("getUnderageReactivationDecision не торкається BLOCKER (джоб днів народження)", () => {
    it("BLOCKER + REJECTED_SYSTEM_UNDERAGE -> null", () => {
        expect(getUnderageReactivationDecision({ ...base, hrDecision: "REJECTED_SYSTEM_UNDERAGE" } as never)).toBeNull();
    });
    it("REJECTED + REJECTED_SYSTEM_UNDERAGE досі працює", () => {
        expect(
            getUnderageReactivationDecision({ ...base, status: CandidateStatus.REJECTED, hrDecision: "REJECTED_SYSTEM_UNDERAGE" } as never)
        ).not.toBeNull();
    });
});

describe("returnBlockedCandidateIfNeeded: справжній репозиторій і guard, мок Prisma", () => {
    async function setup(rowStatus: string) {
        vi.resetModules();
        const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "c1", status: data.status, user: { telegramId: 1n },
        }));
        const findUnique = vi.fn(async () => ({ ...base, status: rowStatus }));
        const queryRaw = vi.fn(async () => [{ status: rowStatus }]);
        const client = { candidate: { update, findUnique }, $queryRaw: queryRaw };
        const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(client));
        vi.doMock("../../db/core.js", () => ({ default: { ...client, $transaction } }));
        vi.doMock("../../core/log-events.js", () => ({ logBusinessEvent: vi.fn(), logAuditEvent: vi.fn() }));
        vi.doMock("../timeline-service.js", () => ({ timelineService: { trackStatusChange: vi.fn(async () => {}) } }));
        const { returnBlockedCandidateIfNeeded } = await import("../blocker-return-service.js");
        return { returnBlockedCandidateIfNeeded, update };
    }

    it("Діана: BLOCKER, hrDecision null, INTERVIEW -> WAITLIST_HR", async () => {
        const { returnBlockedCandidateIfNeeded, update } = await setup("BLOCKER");
        const result = await returnBlockedCandidateIfNeeded({ ...base, currentStep: FunnelStep.INTERVIEW } as never, "free_text");
        expect(result?.mode).toBe("INTERVIEW_WAITLIST");
        expect(update).toHaveBeenCalledTimes(1);
        const data = (update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
        expect(data).toMatchObject({ status: CandidateStatus.WAITLIST_HR });
        expect(data.statusChangedAt).toBeInstanceOf(Date);
    });

    it("статус уже змінили -> null, запису немає", async () => {
        const { returnBlockedCandidateIfNeeded, update } = await setup("REJECTED");
        const result = await returnBlockedCandidateIfNeeded({ ...base, currentStep: FunnelStep.INTERVIEW } as never, "free_text");
        expect(result).toBeNull();
        expect(update).not.toHaveBeenCalled();
    });
});
