import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hrService } from '../hr-service.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';
import { interviewRepository } from '../../repositories/interview-repository.js';
import { locationRepository } from '../../repositories/location-repository.js';
import { accessService } from '../access-service.js';
import { CandidateStatus, FunnelStep } from '@prisma/client';

// Mock Prisma
vi.mock('../../db/core.js', () => ({
    default: {
        interviewSlot: {
            findMany: vi.fn().mockResolvedValue([])
        },
        lead: {
            count: vi.fn().mockResolvedValue(0)
        },
        candidate: {
            count: vi.fn().mockResolvedValue(1), // Default for Final Step stages (5 stages * 1 = 5 total)
            findMany: vi.fn().mockResolvedValue([])
        },
        staffProfile: {
            findUnique: vi.fn().mockResolvedValue(null)
        },
        workShift: {
            findFirst: vi.fn().mockResolvedValue(null)
        }
    }
}));

// Mock dependencies
vi.mock('../../repositories/candidate-repository.js', () => ({
    candidateRepository: {
        countByStatusAndSlot: vi.fn(),
        countHiredAfter: vi.fn(),
        countByStatus: vi.fn(),
        countUnread: vi.fn(),
        countUnreadByScope: vi.fn(),
        countByOfflineStagingStep: vi.fn(),
        findByStatusWithUser: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        reopenNoShowCandidate: vi.fn(),
        findByCityAndStatus: vi.fn()
    }
}));

vi.mock('../../repositories/interview-repository.js', () => ({
    interviewRepository: {
        countBookedInRange: vi.fn(),
        findBookedAfter: vi.fn(),
        findWithCandidateInWindow: vi.fn(),
        findSlotWithCandidate: vi.fn()
    }
}));

vi.mock('../../repositories/location-repository.js', () => ({
    locationRepository: {
        findAllCities: vi.fn(),
        findAllActive: vi.fn(),
        countCandidatesByCity: vi.fn(),
        findWithWaitlist: vi.fn()
    }
}));

vi.mock('../../repositories/timeline-repository.js', () => ({
    timelineRepository: {
        createEvent: vi.fn().mockResolvedValue({})
    }
}));

vi.mock('../../config.js', () => ({
    HR_IDS: [111111],
    MENTOR_IDS: [444444]
}));

vi.mock('../access-service.js', () => ({
    accessService: {
        syncUserAccess: vi.fn().mockResolvedValue({})
    }
}));

vi.mock('../schedule-sync.js', () => ({
    scheduleSyncService: {
        syncTeam: vi.fn().mockResolvedValue({ teamMapping: {} }),
        syncSchedule: vi.fn().mockResolvedValue({ success: true })
    }
}));

vi.mock('../booking-service.js', () => ({
    bookingService: {
        cancelInterviewSlot: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../utils/cleanup.js', () => ({
    cleanupUserSessionMessages: vi.fn().mockResolvedValue(undefined),
    trackUserMessage: vi.fn().mockResolvedValue(undefined)
}));

describe('hrService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getHubStats', () => {
        it('should aggregate statistics correctly', async () => {
            vi.mocked(candidateRepository.countByStatusAndSlot).mockResolvedValue(5);
            vi.mocked(interviewRepository.countBookedInRange).mockResolvedValue(3);
            vi.mocked(candidateRepository.countHiredAfter).mockResolvedValue(2);
            vi.mocked(candidateRepository.countByStatus).mockResolvedValue(1);
            vi.mocked(candidateRepository.countUnreadByScope).mockResolvedValue(4);
            vi.mocked(candidateRepository.countByOfflineStagingStep).mockResolvedValue(2);
            const prisma = (await import('../../db/core.js')).default;
            vi.mocked(prisma.candidate.count)
                .mockResolvedValueOnce(8) // HR waitlist total
                .mockResolvedValueOnce(5) // No date fits
                .mockResolvedValue(1); // Final step stages

            const stats = await hrService.getHubStats();

            expect(stats.newCandidates).toBe(5);
            expect(stats.todayInterviews).toBe(3);
            expect(stats.hiredWeek).toBe(2);
            // inboxTotal is HR-only work: tattooCount(1) + unreadCount(4) + noSlotCount(5) = 10
            expect(stats.inboxTotal).toBe(10);
        });

        it('should count no-slot waitlist candidates using the same filter as the No Date Fits list', async () => {
            vi.mocked(candidateRepository.countByStatusAndSlot).mockResolvedValue(0);
            vi.mocked(interviewRepository.countBookedInRange).mockResolvedValue(0);
            vi.mocked(candidateRepository.countHiredAfter).mockResolvedValue(0);
            vi.mocked(candidateRepository.countByStatus).mockResolvedValue(0);
            vi.mocked(candidateRepository.countUnreadByScope).mockResolvedValue(0);
            const prisma = (await import('../../db/core.js')).default;
            vi.mocked(prisma.candidate.count).mockResolvedValue(0);

            await hrService.getHubStats();

            expect(prisma.candidate.count).toHaveBeenCalledWith({
                where: {
                    status: { in: [CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST] },
                    isWaitlisted: true,
                    currentStep: FunnelStep.INTERVIEW
                }
            });
        });
    });

    describe('makeDecision', () => {
        const mockApi = {
            sendMessage: vi.fn().mockResolvedValue({})
        };

        it('should return false if candidate not found', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue(null);
            const result = await hrService.makeDecision(mockApi, 'cand1', 'ACCEPTED');
            expect(result).toBe(false);
        });

        it('should update candidate with ACCEPTED decision but NOT update status yet', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ id: 'cand1', user: { id: 'user1', telegramId: 123 } } as any);
            const result = await hrService.makeDecision(mockApi, 'cand1', 'ACCEPTED');
            expect(result).toBe(true);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', {
                currentStep: 'INTERVIEW',
                hrDecision: 'ACCEPTED',
                notificationSent: false,
                materialsSent: false,
                hasUnreadMessage: false,
                isWaitlisted: false
            });
        });

        it('should update candidate with REJECTED decision but NOT update status yet', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ id: 'cand1', user: { id: 'user1', telegramId: 123 } } as any);
            const result = await hrService.makeDecision(mockApi, 'cand1', 'REJECTED');
            expect(result).toBe(true);

            // Should NOT have status REJECTED or notificationSent: true immediately
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', {
                currentStep: 'INTERVIEW',
                hrDecision: 'REJECTED',
                notificationSent: false,
                materialsSent: false,
                hasUnreadMessage: false
            });
        });
    });

    describe('offline staging withdrawal flows', () => {
        const mockApi = {
            sendMessage: vi.fn().mockResolvedValue({})
        };

        it('cancels candidate staging, clears assignment, and notifies partner and HR', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand1',
                fullName: 'Аліна Шульська',
                city: 'Lviv',
                status: CandidateStatus.STAGING_ACTIVE,
                firstShiftDate: new Date('2026-05-01T12:00:00.000Z'),
                firstShiftTime: '15:00-17:00',
                location: { name: 'Karamel' },
                firstShiftPartner: { user: { telegramId: 222222 } },
                user: { telegramId: 333333 }
            } as any);

            const result = await hrService.cancelCandidateStaging(mockApi, 'cand1');

            expect(result).toEqual({ ok: true });
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', {
                firstShiftDate: null,
                firstShiftTime: null,
                firstShiftPartner: { disconnect: true },
                status: CandidateStatus.STAGING_SETUP,
                currentStep: FunnelStep.FIRST_SHIFT,
                notificationSent: false,
                stagingNotifiedAt: null
            });
            expect(mockApi.sendMessage).toHaveBeenCalledWith(
                222222,
                expect.stringContaining('Стажування скасовано'),
                { parse_mode: 'HTML' }
            );
            expect(mockApi.sendMessage).toHaveBeenCalledWith(
                111111,
                expect.stringContaining('Internship Cancelled!'),
                { parse_mode: 'HTML' }
            );
        });

        it('rejects candidate who withdrew during staging and syncs access', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand2',
                fullName: 'Аліна Шульська',
                city: 'Lviv',
                status: CandidateStatus.STAGING_SETUP,
                firstShiftDate: new Date('2026-05-01T12:00:00.000Z'),
                firstShiftTime: '15:00-17:00',
                location: { name: 'Karamel' },
                firstShiftPartner: { user: { telegramId: 222222 } },
                user: { telegramId: 333333 }
            } as any);

            const result = await hrService.rejectCandidateWithdrawalFromStaging(mockApi, 'cand2');

            expect(result).toEqual({ ok: true });
            expect(candidateRepository.update).toHaveBeenCalledWith('cand2', {
                status: CandidateStatus.REJECTED,
                hrDecision: 'REJECTED',
                candidateDecision: 'Кандидатка відмовилась від участі на етапі офлайн-стажування',
                firstShiftDate: null,
                firstShiftTime: null,
                firstShiftPartner: { disconnect: true },
                notificationSent: false,
                stagingNotifiedAt: null,
                currentStep: FunnelStep.FIRST_SHIFT
            });
            expect(mockApi.sendMessage).toHaveBeenCalledWith(
                222222,
                expect.stringContaining('не буде продовжувати відбір'),
                { parse_mode: 'HTML' }
            );
            expect(mockApi.sendMessage).toHaveBeenCalledWith(
                333333,
                expect.stringContaining('Ми закрили твою заявку')
            );
            expect(accessService.syncUserAccess).toHaveBeenCalledWith(333333, 'Candidate withdrew during offline staging');
        });
    });

    describe('getCityRecruitmentStats', () => {
        it('should return cities with their recruitment stats', async () => {
            vi.mocked(locationRepository.findAllActive).mockResolvedValue([
                { id: 'loc1', city: 'Kyiv', name: 'Center', neededCount: 5 }
            ] as any);

            const prisma = (await import('../../db/core.js')).default;
            vi.mocked(prisma.candidate.findMany).mockResolvedValue([
                { id: 'cand1', status: 'SCREENING', notificationSent: false }
            ] as any);

            const result = await hrService.getCityRecruitmentStats();

            expect(result).toHaveLength(1);
            expect(result[0].city).toBe('Kyiv');
            expect(result[0].candidateCount).toBe(1);
        });
    });

    describe('waitlist pools', () => {
        it('should build location reserve cities from location-full candidates only', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([
                { id: 'cand1', city: 'Kyiv' },
                { id: 'cand2', city: 'Lviv' },
                { id: 'cand3', city: 'Inactive City' }
            ] as any);
            vi.mocked(locationRepository.findAllCities).mockResolvedValue(['Kyiv', 'Lviv']);

            const cities = await hrService.getWaitlistCities();

            expect(cities).toEqual(['Kyiv', 'Lviv']);
            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                [CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST],
                {
                    isWaitlisted: true,
                    currentStep: FunnelStep.INITIAL_TEST
                }
            );
        });
    });

    describe('notifyWaitlist', () => {
        it('should invite candidates who need interview slots and make them visible to invite reminders', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([
                {
                    id: 'cand1',
                    fullName: 'Test Candidate',
                    user: { telegramId: 123 }
                }
            ] as any);
            vi.mocked(candidateRepository.update).mockResolvedValue({} as any);
            const api = {
                sendMessage: vi.fn().mockResolvedValue({})
            };

            const count = await hrService.notifyWaitlist(api);

            expect(count).toBe(1);
            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                [CandidateStatus.SCREENING, CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST],
                {
                    currentStep: FunnelStep.INTERVIEW,
                    OR: [
                        { isWaitlisted: true },
                        {
                            status: CandidateStatus.SCREENING,
                            isWaitlisted: false,
                            interviewWaitlistReason: { in: ['NO_SLOTS_AVAILABLE', 'NO_DATE_FITS'] }
                        }
                    ]
                }
            );
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', {
                status: CandidateStatus.SCREENING,
                isWaitlisted: false,
                notificationSent: true,
                interviewWaitlistReason: null,
                interviewInvitedAt: expect.any(Date)
            });
        });

        it('should filter legacy no-slot candidates without losing unknown reasons', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([]);

            await hrService.getWaitlistNoSlot(null);

            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                [CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST],
                {
                    isWaitlisted: true,
                    currentStep: FunnelStep.INTERVIEW,
                    OR: [
                        { interviewWaitlistReason: null },
                        { NOT: { interviewWaitlistReason: { in: ['NO_SLOTS_AVAILABLE', 'NO_DATE_FITS'] } } }
                    ]
                }
            );
        });

        it('should find active screening candidates who need a different interview slot', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([]);

            await hrService.getWaitlistNoSlot('NO_DATE_FITS');

            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                [CandidateStatus.SCREENING, CandidateStatus.WAITLIST_HR, CandidateStatus.WAITLIST],
                {
                    currentStep: FunnelStep.INTERVIEW,
                    OR: [
                        { isWaitlisted: true, interviewWaitlistReason: 'NO_DATE_FITS' },
                        {
                            status: CandidateStatus.SCREENING,
                            isWaitlisted: false,
                            interviewWaitlistReason: 'NO_DATE_FITS'
                        }
                    ]
                }
            );
        });

        it('should block interview invite for age-ineligible legacy candidates', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand-age',
                city: 'Kyiv',
                locationId: 'loc1',
                birthDate: new Date('1994-09-23T00:00:00.000Z'),
                user: { id: 'user-age', telegramId: 123n }
            } as any);

            const api = {
                sendMessage: vi.fn()
            };

            const result = await hrService.inviteCandidate(api, 'cand-age');

            expect(result).toEqual({ ok: false, reason: 'age_ineligible' });
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-age', {
                status: CandidateStatus.REJECTED,
                hrDecision: 'AGE_LIMIT',
                isWaitlisted: false,
                notificationSent: false,
                interviewWaitlistReason: null,
                interviewInvitedAt: null,
                hasUnreadMessage: false,
            });
        });
    });

    describe('rescheduleCandidate', () => {
        it('reopens no-show candidates through the dedicated recovery path', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand1',
                status: CandidateStatus.REJECTED,
                hrDecision: 'NOSHOW',
                interviewSlotId: 'slot1',
                user: { id: 'user1', telegramId: 123 }
            } as any);

            const { bookingService } = await import('../booking-service.js');
            vi.mocked(candidateRepository.reopenNoShowCandidate).mockResolvedValue({ id: 'cand1' } as any);

            const result = await hrService.rescheduleCandidate('cand1');

            expect(result).toBe(true);
            expect(bookingService.cancelInterviewSlot).toHaveBeenCalledWith('slot1');
            expect(candidateRepository.reopenNoShowCandidate).toHaveBeenCalledWith('cand1');
            expect(candidateRepository.update).not.toHaveBeenCalled();
        });
    });

    describe('confirmFinalSchedule', () => {
        it('should keep staging date untouched and sync only team data when hiring', async () => {
            const candidateBeforeHire = {
                id: 'cand1',
                userId: 'user1',
                fullName: 'Гудим Анна Любомирівна',
                firstShiftDate: new Date('2026-04-10T12:00:00.000Z'),
                locationId: 'old-location',
                user: { id: 'user1', telegramId: 768450703n }
            } as any;
            const hiredCandidate = {
                ...candidateBeforeHire,
                status: CandidateStatus.HIRED
            } as any;

            vi.mocked(candidateRepository.findById).mockResolvedValueOnce(candidateBeforeHire);
            vi.mocked(candidateRepository.update)
                .mockResolvedValueOnce(hiredCandidate);

            const { scheduleSyncService } = await import('../schedule-sync.js');

            const result = await hrService.confirmFinalSchedule('cand1');

            expect(scheduleSyncService.syncTeam).toHaveBeenCalled();
            expect(scheduleSyncService.syncSchedule).toHaveBeenCalledWith('Актуальний розклад', {});
            expect(candidateRepository.update).toHaveBeenCalledTimes(1);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', { status: CandidateStatus.HIRED });
            expect(result?.candidate).toEqual(hiredCandidate);
        });
    });
});
