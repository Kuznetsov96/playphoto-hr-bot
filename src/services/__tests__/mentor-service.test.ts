import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateStatus, FunnelStep } from '@prisma/client';

vi.mock('grammy', () => {
    class MockInlineKeyboard {
        text() { return this; }
    }
    return {
        Bot: vi.fn(),
        InlineKeyboard: MockInlineKeyboard
    };
});

vi.mock('../../db/core.js', () => ({
    default: {
        candidate: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        staffProfile: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
        trainingSlot: { count: vi.fn().mockResolvedValue(0) },
        trainingSession: { findFirst: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) }
    }
}));

vi.mock('../../repositories/candidate-repository.js', () => ({
    candidateRepository: {
        findById: vi.fn(),
        findByUserId: vi.fn(),
        update: vi.fn(),
        findByStatusWithUser: vi.fn().mockResolvedValue([]),
        findByStatus: vi.fn().mockResolvedValue([]),
        countByStatus: vi.fn().mockResolvedValue(0),
        countUnreadByScope: vi.fn().mockResolvedValue(0),
        findUnreadByScope: vi.fn().mockResolvedValue([]),
        findByCityAndStatus: vi.fn().mockResolvedValue([])
    }
}));

vi.mock('../../repositories/training-repository.js', () => ({
    trainingRepository: {
        countBookedSlotsByDateRange: vi.fn().mockResolvedValue(0),
        createSession: vi.fn(),
        createSlot: vi.fn(),
        updateSlot: vi.fn()
    }
}));

vi.mock('../google-calendar.js', () => ({
    googleCalendar: {
        createEvent: vi.fn()
    }
}));

vi.mock('../../repositories/location-repository.js', () => ({
    locationRepository: {}
}));

vi.mock('../access-service.js', () => ({
    accessService: {
        createInviteLink: vi.fn().mockResolvedValue('https://t.me/+test'),
        staticJoinLink: 'https://t.me/+static'
    }
}));

vi.mock('../../config.js', () => ({
    ADMIN_IDS: [],
    KNOWLEDGE_BASE_LINK: 'https://kb.test',
    NDA_LINK: 'https://nda.test',
    PHOTOGRAPHER_GUIDE_LINK: 'https://guide.test',
    MENTOR_IDS: []
}));

vi.mock('../../utils/cleanup.js', () => ({
    cleanupUserSessionMessages: vi.fn()
}));

vi.mock('../../utils/bot-blocked.js', () => ({
    isBotBlocked: vi.fn().mockReturnValue(false),
    handleBlockedCandidate: vi.fn()
}));

vi.mock('../../utils/bot-utils.js', () => ({
    createKyivDate: vi.fn()
}));

vi.mock('../../utils/location-data-helper.js', () => ({
    getLocationDetails: vi.fn()
}));

vi.mock('../../utils/string-utils.js', () => ({
    extractFirstName: vi.fn().mockReturnValue('Test')
}));

vi.mock('../../constants/candidate-texts.js', () => ({
    CANDIDATE_TEXTS: {
        "discovery-invite": () => "Test discovery invite text",
        "training-manual-invite": () => "training invite",
        "mentor-manual-discovery-assigned": () => "discovery invite"
    }
}));

vi.mock('../../repositories/timeline-repository.js', () => ({
    timelineRepository: { createEvent: vi.fn() }
}));

import { mentorService } from '../mentor-service.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';
import { accessService } from '../access-service.js';
import { trainingRepository } from '../../repositories/training-repository.js';
import { googleCalendar } from '../google-calendar.js';
import prisma from '../../db/core.js';
import { createKyivDate } from '../../utils/bot-utils.js';

describe('MentorService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('sendMaterials', () => {
        it('should reject candidate without hrDecision=ACCEPTED', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand1',
                status: CandidateStatus.WAITLIST,
                hrDecision: null,
                currentStep: FunnelStep.INITIAL_TEST,
                isWaitlisted: true,
                materialsSent: false,
                user: { telegramId: 123n }
            } as any);

            const result = await mentorService.sendMaterials({} as any, 'cand1');

            expect(result).toBeNull();
            expect(candidateRepository.update).not.toHaveBeenCalled();
        });

        it('should allow candidate with hrDecision=ACCEPTED and currentStep=TRAINING', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand2',
                status: CandidateStatus.WAITLIST,
                hrDecision: 'ACCEPTED',
                currentStep: FunnelStep.TRAINING,
                isWaitlisted: true,
                materialsSent: true,
                discoverySlotId: null,
                user: { telegramId: 456n }
            } as any);

            const result = await mentorService.sendMaterials({} as any, 'cand2');

            expect(result).not.toBeNull();
            expect(result?.telegramId).toBe(456);
            expect(candidateRepository.update).toHaveBeenCalled();
        });

        it('should allow ACCEPTED candidate with materialsSent=false (first-time materials)', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand3',
                status: CandidateStatus.ACCEPTED,
                hrDecision: 'ACCEPTED',
                notificationSent: true,
                currentStep: FunnelStep.TRAINING,
                isWaitlisted: false,
                materialsSent: false,
                user: { telegramId: 789n }
            } as any);

            const result = await mentorService.sendMaterials({} as any, 'cand3');

            expect(result).not.toBeNull();
            expect(candidateRepository.update).toHaveBeenCalled();
        });

        it('should mark candidate as accepted before creating the private channel invite', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand4',
                status: CandidateStatus.INTERVIEW_COMPLETED,
                hrDecision: 'ACCEPTED',
                notificationSent: true,
                currentStep: FunnelStep.TRAINING,
                isWaitlisted: false,
                materialsSent: false,
                user: { telegramId: 987n }
            } as any);
            vi.mocked(candidateRepository.update).mockResolvedValue({} as any);
            vi.mocked(accessService.createInviteLink).mockResolvedValue('https://t.me/+fresh');

            const result = await mentorService.sendMaterials({} as any, 'cand4');

            expect(result).not.toBeNull();
            expect(candidateRepository.update).toHaveBeenCalledWith('cand4', expect.objectContaining({
                status: 'ACCEPTED',
                notificationSent: true,
                isWaitlisted: false
            }));
            expect(accessService.createInviteLink).toHaveBeenCalledWith(987n);
            expect(vi.mocked(candidateRepository.update).mock.invocationCallOrder[0])
                .toBeLessThan(vi.mocked(accessService.createInviteLink).mock.invocationCallOrder[0]!);
        });
    });

    describe('notifyWaitlist', () => {
        it('should query mentor waitlist without notificationSent guard', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([]);

            await mentorService.getCandidates(true);

            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST],
                expect.objectContaining({
                    isWaitlisted: true,
                    currentStep: FunnelStep.TRAINING
                })
            );
            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                [CandidateStatus.WAITLIST_MENTOR, CandidateStatus.WAITLIST],
                expect.not.objectContaining({ notificationSent: true })
            );
        });

        it('should count mentor waitlist without notificationSent guard', async () => {
            await mentorService.getWaitlistCount();

            expect((prisma as any).candidate.count).toHaveBeenCalledWith({
                where: expect.objectContaining({
                    isWaitlisted: true,
                    currentStep: FunnelStep.TRAINING
                })
            });
            expect((prisma as any).candidate.count).toHaveBeenCalledWith({
                where: expect.not.objectContaining({ notificationSent: true })
            });
        });

        it('should notify candidate with materialsSent=true even without hrDecision', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([
                {
                    id: 'cand-legacy',
                    status: CandidateStatus.WAITLIST,
                    currentStep: FunnelStep.TRAINING,
                    isWaitlisted: true,
                    hrDecision: null,
                    materialsSent: true,
                    notificationSent: true,
                    user: { telegramId: 333n }
                } as any
            ]);

            const mockApi = { sendMessage: vi.fn().mockResolvedValue({}) };
            const count = await mentorService.notifyWaitlist(mockApi);

            expect(count).toBe(1);
            expect(mockApi.sendMessage).toHaveBeenCalledWith(333, expect.any(String), expect.any(Object));
        });

        it('should only notify candidates who passed HR or have materials sent', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([
                {
                    id: 'cand-no-hr',
                    status: CandidateStatus.WAITLIST_MENTOR,
                    currentStep: FunnelStep.TRAINING,
                    isWaitlisted: true,
                    hrDecision: null,
                    materialsSent: false,
                    notificationSent: false,
                    user: { telegramId: 111n }
                } as any,
                {
                    id: 'cand-mentor',
                    status: CandidateStatus.WAITLIST_MENTOR,
                    currentStep: FunnelStep.TRAINING,
                    isWaitlisted: true,
                    hrDecision: 'ACCEPTED',
                    materialsSent: false,
                    notificationSent: true,
                    user: { telegramId: 222n }
                } as any
            ]);

            const mockApi = { sendMessage: vi.fn().mockResolvedValue({}) };
            const count = await mentorService.notifyWaitlist(mockApi);

            expect(count).toBe(1);
            expect(mockApi.sendMessage).toHaveBeenCalledTimes(1);
            expect(mockApi.sendMessage).toHaveBeenCalledWith(222, expect.any(String), expect.any(Object));
            expect(candidateRepository.update).toHaveBeenCalledTimes(1);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-mentor', expect.objectContaining({
                status: 'ACCEPTED',
                isWaitlisted: false
            }));
        });

        it('should notify waitlist candidate with materialsSent=true even when notificationSent=false', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([
                {
                    id: 'cand-visible',
                    status: CandidateStatus.WAITLIST_MENTOR,
                    currentStep: FunnelStep.TRAINING,
                    isWaitlisted: true,
                    hrDecision: null,
                    materialsSent: true,
                    notificationSent: false,
                    user: { telegramId: 444n }
                } as any
            ]);

            const mockApi = { sendMessage: vi.fn().mockResolvedValue({}) };
            const count = await mentorService.notifyWaitlist(mockApi);

            expect(count).toBe(1);
            expect(mockApi.sendMessage).toHaveBeenCalledWith(444, expect.any(String), expect.any(Object));
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-visible', expect.objectContaining({
                status: 'ACCEPTED',
                isWaitlisted: false
            }));
        });
    });

    describe('manual slot overlap guards', () => {
        it('should create a calendar event and persist meet link for manual training bookings', async () => {
            const start = new Date('2026-05-04T08:30:00.000Z');
            const end = new Date('2026-05-04T08:50:00.000Z');
            vi.mocked(createKyivDate).mockReturnValue(start as any);
            vi.mocked((prisma as any).trainingSession.findFirst).mockResolvedValue(null);
            vi.mocked(trainingRepository.createSession).mockResolvedValue({ id: 'session-1' } as any);
            vi.mocked(trainingRepository.createSlot).mockResolvedValue({ id: 'slot-1', startTime: start, endTime: end } as any);
            vi.mocked(googleCalendar.createEvent).mockResolvedValue({ eventId: 'event-1', meetLink: 'https://meet.test/training' } as any);
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand-new',
                fullName: 'Candidate New',
                trainingSlotId: null,
                user: { telegramId: 123n, username: 'candidate' }
            } as any);

            const result = await mentorService.bookTrainingSlotFromText('cand-new', '04.05 11:30');

            expect(result.success).toBe(true);
            expect(googleCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
                summary: 'Навчання: Candidate New',
                startTime: start,
                endTime: end,
                calendarType: 'training'
            }));
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-new', expect.objectContaining({
                status: 'TRAINING_SCHEDULED',
                trainingMeetLink: 'https://meet.test/training',
                trainingSlot: { connect: { id: 'slot-1' } }
            }));
            expect(trainingRepository.updateSlot).toHaveBeenCalledWith('slot-1', { googleEventId: 'event-1' });
        });

        it('should create a calendar event and persist meet link for manual discovery bookings', async () => {
            const start = new Date('2026-05-04T08:30:00.000Z');
            const end = new Date('2026-05-04T08:50:00.000Z');
            vi.mocked(createKyivDate).mockReturnValue(start as any);
            vi.mocked((prisma as any).trainingSession.findFirst).mockResolvedValue(null);
            vi.mocked(trainingRepository.createSession).mockResolvedValue({ id: 'session-1' } as any);
            vi.mocked(trainingRepository.createSlot).mockResolvedValue({ id: 'slot-1', startTime: start, endTime: end } as any);
            vi.mocked(googleCalendar.createEvent).mockResolvedValue({ eventId: 'event-1', meetLink: 'https://meet.test/discovery' } as any);
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand-new',
                fullName: 'Candidate New',
                discoverySlotId: null,
                location: { name: 'Kyiv' },
                user: { telegramId: 123n, username: 'candidate' }
            } as any);

            const result = await mentorService.bookDiscoverySlotFromText('cand-new', '04.05 11:30');

            expect(result.success).toBe(true);
            expect(googleCalendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
                summary: 'Знайомство: Candidate New',
                startTime: start,
                endTime: end,
                calendarType: 'training'
            }));
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-new', expect.objectContaining({
                status: 'DISCOVERY_SCHEDULED',
                trainingMeetLink: 'https://meet.test/discovery',
                discoverySlot: { connect: { id: 'slot-1' } }
            }));
            expect(trainingRepository.updateSlot).toHaveBeenCalledWith('slot-1', { googleEventId: 'event-1' });
        });

        it('should block training booking text when an overlapping slot is already booked by a HIRED candidate', async () => {
            const start = new Date('2026-05-04T08:30:00.000Z');
            vi.mocked(createKyivDate).mockReturnValue(start as any);
            vi.mocked((prisma as any).trainingSession.findFirst).mockResolvedValue({
                slots: [
                    {
                        isBooked: true,
                        candidate: { id: 'cand-existing', status: CandidateStatus.HIRED },
                        candidateDiscovery: null,
                    }
                ]
            } as any);

            const result = await mentorService.bookTrainingSlotFromText('cand-new', '04.05 11:30');

            expect(result).toEqual({
                success: false,
                error: '✨ This time slot is already occupied. Please choose another window. 📅'
            });
            expect(prisma.trainingSession.deleteMany).not.toHaveBeenCalled();
            expect(trainingRepository.createSession).not.toHaveBeenCalled();
        });

        it('should block discovery booking text when an overlapping discovery slot is already booked', async () => {
            const start = new Date('2026-05-04T08:30:00.000Z');
            vi.mocked(createKyivDate).mockReturnValue(start as any);
            vi.mocked((prisma as any).trainingSession.findFirst).mockResolvedValue({
                slots: [
                    {
                        isBooked: true,
                        candidate: null,
                        candidateDiscovery: { id: 'cand-existing' },
                    }
                ]
            } as any);

            const result = await mentorService.bookDiscoverySlotFromText('cand-new', '04.05 11:30');

            expect(result).toEqual({
                success: false,
                error: '✨ This time slot is already occupied. Please choose another window. 📅'
            });
            expect(prisma.trainingSession.deleteMany).not.toHaveBeenCalled();
            expect(trainingRepository.createSession).not.toHaveBeenCalled();
        });
    });

});
