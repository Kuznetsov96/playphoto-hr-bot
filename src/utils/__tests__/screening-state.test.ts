import { describe, expect, it } from "vitest";
import { CandidateStatus, FunnelStep } from "@prisma/client";
import { canRescheduleInterview, canScheduleInterview, hasActiveInterviewBooking, hasInterviewStarted, hasLiveInterviewInvitation, isQuestionnaireOpen, isScreeningComplete } from "../screening-state.js";

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

    it("отказаться можно только от действующего приглашения", () => {
        const invited = {
            status: CandidateStatus.SCREENING,
            currentStep: FunnelStep.INITIAL_TEST,
            notificationSent: true,
            interviewInvitedAt: new Date("2026-09-29T10:00:00Z"),
            interviewSlotId: null,
        };
        expect(hasLiveInterviewInvitation(invited)).toBe(true);

        // 30.09.2026: рассылка «нові вікна» снимает interviewInvitedAt, а
        // напоминание суточной давности с красной кнопкой висит в чате.
        // Кандидатка ждала окна, тапнула его — и заявка закрылась.
        expect(hasLiveInterviewInvitation({ ...invited, currentStep: FunnelStep.INTERVIEW, interviewInvitedAt: null })).toBe(false);
        // «Не бачу зручного часу» — ждёт окна, приглашения нет.
        expect(hasLiveInterviewInvitation({ ...invited, notificationSent: false })).toBe(false);
        // Переносит время — WAITLIST_HR, отметка приглашения старая.
        expect(hasLiveInterviewInvitation({ ...invited, status: CandidateStatus.WAITLIST_HR })).toBe(false);
        // Записалась — отказ идёт через кнопки брони, не приглашения.
        expect(hasLiveInterviewInvitation({ ...invited, interviewSlotId: "s1" })).toBe(false);
    });

    it("співбесіда почалась у момент старту слота", () => {
        const now = new Date("2026-10-01T12:15:00Z");
        expect(hasInterviewStarted(new Date("2026-10-01T12:15:00Z"), now)).toBe(true);
        expect(hasInterviewStarted(new Date("2026-10-01T12:16:00Z"), now)).toBe(false);
        expect(hasInterviewStarted(null, now)).toBe(false);
    });

    it("перенести можна лише власний запис, що ще не почався", () => {
        const now = new Date("2026-10-01T12:00:00Z");
        const booked = {
            status: CandidateStatus.INTERVIEW_SCHEDULED,
            interviewSlotId: "s1",
            interviewSlot: { startTime: new Date("2026-10-01T12:15:00Z") },
        };
        expect(canRescheduleInterview(booked, now)).toBe(true);
        expect(canRescheduleInterview(booked, new Date("2026-10-01T12:31:00Z"))).toBe(false);
        expect(canRescheduleInterview({ ...booked, interviewSlotId: null }, now)).toBe(false);
        expect(canRescheduleInterview({ ...booked, status: CandidateStatus.INTERVIEW_COMPLETED }, now)).toBe(false);
    });
});
