import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { getBlockerReturnDecision } from "../blocker-return-service.js";

const location = { neededCount: 2, isHidden: false, isHiddenFromCandidates: false, minAge: null } as never;

const full = {
    id: "c1",
    status: CandidateStatus.BLOCKER,
    hrDecision: null,
    fullName: "Іванна Тест",
    gender: "female",
    birthDate: new Date("2000-01-01"),
    city: "Львів",
    locationId: "l1",
    appearance: "Без особливостей",
    source: "instagram",
    location,
    currentStep: FunnelStep.INITIAL_TEST,
};

const LOSS = { candidateDecision: null, lossStage: null, lossReason: null, lostAt: null };

describe("getBlockerReturnDecision", () => {
    it("не BLOCKER -> null", () => {
        expect(getBlockerReturnDecision({ ...full, status: CandidateStatus.REJECTED })).toBeNull();
    });

    it("анкета не заповнена -> RESUME_SCREENING", () => {
        const d = getBlockerReturnDecision({ ...full, appearance: null, source: null });
        expect(d?.mode).toBe("RESUME_SCREENING");
        expect(d?.patch).toMatchObject({ status: CandidateStatus.SCREENING });
        expect(d?.patch).not.toHaveProperty("interviewInvitedAt");
    });

    it("анкета заповнена, тату-фото -> MANUAL_REVIEW", () => {
        const d = getBlockerReturnDecision({ ...full, tattooPhotoId: "p1" });
        expect(d?.mode).toBe("MANUAL_REVIEW");
        expect(d?.patch).not.toHaveProperty("interviewInvitedAt");
    });

    it("INTERVIEW -> INTERVIEW_WAITLIST", () => {
        const d = getBlockerReturnDecision({ ...full, currentStep: FunnelStep.INTERVIEW });
        expect(d).toEqual({
            mode: "INTERVIEW_WAITLIST",
            patch: { status: CandidateStatus.WAITLIST_HR, currentStep: FunnelStep.INTERVIEW, isWaitlisted: true, ...LOSS },
        });
    });

    it.each([FunnelStep.TRAINING, FunnelStep.FIRST_SHIFT])("%s без hrDecision -> null (ручний розбір, hrDecision не вигадуємо)", (currentStep) => {
        expect(getBlockerReturnDecision({ ...full, currentStep })).toBeNull();
    });

    it.each(["REJECTED", "AGE_LIMIT", "NOSHOW"])("%s -> REJECTED без hrDecision в patch", (hrDecision) => {
        const d = getBlockerReturnDecision({ ...full, hrDecision });
        expect(d).toEqual({ mode: "REJECTED", patch: { status: CandidateStatus.REJECTED } });
    });

    it("ACCEPTED -> MENTOR_MANUAL, не ACCEPTED", () => {
        const d = getBlockerReturnDecision({ ...full, hrDecision: "ACCEPTED" });
        expect(d).toEqual({
            mode: "ACCEPTED",
            patch: { status: CandidateStatus.MENTOR_MANUAL, hrDecision: "ACCEPTED", ...LOSS },
        });
    });

    it("REJECTED_SYSTEM_UNDERAGE, вік уже підходить -> внутрішній режим underage", () => {
        const d = getBlockerReturnDecision({ ...full, hrDecision: "REJECTED_SYSTEM_UNDERAGE" });
        expect(d?.mode).toBe("READY_FOR_INTERVIEW");
        expect(d?.patch).toMatchObject({ hrDecision: null, status: CandidateStatus.SCREENING });
    });

    it("REJECTED_SYSTEM_UNDERAGE з незаповненою анкетою -> RESUME_SCREENING", () => {
        const d = getBlockerReturnDecision({ ...full, hrDecision: "REJECTED_SYSTEM_UNDERAGE", appearance: null, source: null });
        expect(d?.mode).toBe("RESUME_SCREENING");
    });

    it("REJECTED_SYSTEM_UNDERAGE, досі неповнолітня -> REJECTED", () => {
        const d = getBlockerReturnDecision({
            ...full,
            hrDecision: "REJECTED_SYSTEM_UNDERAGE",
            birthDate: new Date(Date.now() - 16 * 365 * 24 * 3600 * 1000),
        });
        expect(d).toEqual({ mode: "REJECTED", patch: { status: CandidateStatus.REJECTED } });
    });
});
