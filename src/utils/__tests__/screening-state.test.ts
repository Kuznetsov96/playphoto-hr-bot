import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { isQuestionnaireOpen, isScreeningComplete } from "../screening-state.js";

const complete = {
    status: CandidateStatus.SCREENING,
    currentStep: FunnelStep.INITIAL_TEST,
    notificationSent: false,
    fullName: "Анна Коваль",
    gender: "female",
    birthDate: new Date("2005-01-01"),
    city: "Lviv",
    locationId: "loc-1",
    appearance: "Без особливостей",
    source: "Instagram",
};

describe("screening state", () => {
    it("анкета без источника ещё открыта", () => {
        expect(isQuestionnaireOpen({ ...complete, source: null })).toBe(true);
    });

    it("законченная анкета в SCREENING не открыта — она ждёт приглашения", () => {
        expect(isScreeningComplete(complete)).toBe(true);
        expect(isQuestionnaireOpen(complete)).toBe(false);
    });

    it("приглашённая не открыта, даже если поля неполные", () => {
        expect(isQuestionnaireOpen({ ...complete, source: null, currentStep: FunnelStep.INTERVIEW })).toBe(false);
        expect(isQuestionnaireOpen({ ...complete, source: null, notificationSent: true })).toBe(false);
    });

    it("любой другой статус не открыт", () => {
        for (const status of [CandidateStatus.REJECTED, CandidateStatus.INTERVIEW_SCHEDULED, CandidateStatus.WAITLIST_HR, CandidateStatus.MENTOR_MANUAL]) {
            expect(isQuestionnaireOpen({ ...complete, source: null, status })).toBe(false);
        }
    });
});
