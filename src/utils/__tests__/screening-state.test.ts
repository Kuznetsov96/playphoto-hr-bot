import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { canScheduleInterview, hasActiveInterviewBooking, isQuestionnaireOpen, isScreeningComplete } from "../screening-state.js";

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

describe("interview state", () => {
    it("приглашённая может выбрать время", () => {
        expect(canScheduleInterview({ status: CandidateStatus.SCREENING, notificationSent: true, currentStep: FunnelStep.INITIAL_TEST })).toBe(true);
    });

    it("после сброса приглашения через 48 часов — нет", () => {
        expect(canScheduleInterview({ status: CandidateStatus.WAITLIST_HR, notificationSent: false, currentStep: FunnelStep.INITIAL_TEST })).toBe(false);
    });

    it("отменившая запись и ищущая новое время — да", () => {
        expect(canScheduleInterview({ status: CandidateStatus.WAITLIST_HR, notificationSent: false, currentStep: FunnelStep.INTERVIEW })).toBe(true);
    });

    it("уже записанная или после интервью — нет", () => {
        expect(canScheduleInterview({ status: CandidateStatus.INTERVIEW_SCHEDULED, currentStep: FunnelStep.INTERVIEW, interviewSlotId: "s1" })).toBe(false);
        expect(canScheduleInterview({ status: CandidateStatus.INTERVIEW_COMPLETED, currentStep: FunnelStep.INTERVIEW })).toBe(false);
        expect(canScheduleInterview({ status: CandidateStatus.MENTOR_MANUAL, currentStep: FunnelStep.INTERVIEW })).toBe(false);
    });

    it("управлять записью можно только до интервью и только своей", () => {
        const booked = { status: CandidateStatus.INTERVIEW_SCHEDULED, interviewSlotId: "s1" };
        expect(hasActiveInterviewBooking(booked, "s1")).toBe(true);
        expect(hasActiveInterviewBooking(booked, "s2")).toBe(false);
        expect(hasActiveInterviewBooking({ ...booked, status: CandidateStatus.INTERVIEW_COMPLETED }, "s1")).toBe(false);
        expect(hasActiveInterviewBooking({ ...booked, status: CandidateStatus.ACCEPTED }, "s1")).toBe(false);
    });
});
