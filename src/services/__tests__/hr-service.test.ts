import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hrService } from '../hr-service.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';
import { interviewRepository } from '../../repositories/interview-repository.js';
import { locationRepository } from '../../repositories/location-repository.js';
import { accessService } from '../access-service.js';
import { CandidateStatus, FunnelStep } from '@prisma/client';
import { CANDIDATE_TEXTS } from '../../constants/candidate-texts.js';

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
        user: {
            update: vi.fn().mockResolvedValue({})
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
        findByCityAndStatus: vi.fn(),
        checkFunnelPatch: vi.fn().mockResolvedValue(null),
        requestMirrorPush: vi.fn()
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

vi.mock('../canonical-interview-slots.js', () => ({
    releaseCanonicalInterviewSlot: vi.fn().mockResolvedValue(undefined)
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

        it('REJECTED goes through rejectAfterInterview — status and letter at once', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand1', status: CandidateStatus.INTERVIEW_COMPLETED, hrDecision: null,
                user: { id: 'user1', telegramId: 123 }
            } as any);
            const result = await hrService.makeDecision(mockApi, 'cand1', 'REJECTED');
            expect(result).toBe(true);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', expect.objectContaining({
                status: CandidateStatus.REJECTED,
                hrDecision: 'REJECTED',
            }));
            expect(mockApi.sendMessage).toHaveBeenCalled();
        });
    });

    describe('acceptAfterInterview', () => {
        const api = { sendMessage: vi.fn() };
        const base = { id: 'cand1', hrDecision: null, notificationSent: false, user: { id: 'user1', telegramId: 123 } };

        beforeEach(() => {
            api.sendMessage.mockReset().mockResolvedValue({ message_id: 7 });
        });

        it('after the meeting: MENTOR_MANUAL, the offer letter at once, notificationSent', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ ...base, status: CandidateStatus.INTERVIEW_COMPLETED } as any);

            await expect(hrService.makeDecision(api, 'cand1', 'ACCEPTED')).resolves.toBe(true);

            expect(candidateRepository.update).toHaveBeenNthCalledWith(1, 'cand1', expect.objectContaining({
                status: CandidateStatus.MENTOR_MANUAL, hrDecision: 'ACCEPTED',
            }));
            expect(api.sendMessage).toHaveBeenCalledWith(123, CANDIDATE_TEXTS['worker-offer-accepted'](), expect.objectContaining({ parse_mode: 'HTML' }));
            expect(candidateRepository.update).toHaveBeenLastCalledWith('cand1', { notificationSent: true });
        });

        it('decided during the meeting: completes the interview first, then MENTOR_MANUAL', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ ...base, status: CandidateStatus.INTERVIEW_SCHEDULED } as any);

            await hrService.acceptAfterInterview(api, 'cand1');

            expect(candidateRepository.update).toHaveBeenNthCalledWith(1, 'cand1', expect.objectContaining({
                status: CandidateStatus.INTERVIEW_COMPLETED, interviewCompletedAt: expect.any(Date),
            }));
            expect(candidateRepository.update).toHaveBeenNthCalledWith(2, 'cand1', expect.objectContaining({
                status: CandidateStatus.MENTOR_MANUAL,
            }));
        });

        it('send failure: the command fails with a code', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ ...base, status: CandidateStatus.INTERVIEW_COMPLETED } as any);
            api.sendMessage.mockRejectedValue(new Error('ETIMEDOUT'));

            await expect(hrService.acceptAfterInterview(api, 'cand1')).rejects.toThrow('OFFER_NOT_SENT:send_failed');
        });

        it('already accepted and notified: nothing is sent twice', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                ...base, status: CandidateStatus.MENTOR_MANUAL, hrDecision: 'ACCEPTED', notificationSent: true
            } as any);

            await hrService.acceptAfterInterview(api, 'cand1');

            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(candidateRepository.update).not.toHaveBeenCalled();
        });
    });

    describe('rejectAfterInterview', () => {
        const api = { sendMessage: vi.fn() };
        const base = { id: 'cand1', hrDecision: null, notificationSent: false, interviewSlotId: null, interviewSlot: null, user: { id: 'user1', telegramId: 123 } };

        beforeEach(() => {
            api.sendMessage.mockReset().mockResolvedValue({ message_id: 7 });
        });

        it('after the meeting: REJECTED, the post-interview letter, notificationSent', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ ...base, status: CandidateStatus.INTERVIEW_COMPLETED } as any);

            await expect(hrService.rejectAfterInterview(api, 'cand1')).resolves.toBe(true);

            expect(candidateRepository.update).toHaveBeenNthCalledWith(1, 'cand1', expect.objectContaining({
                status: CandidateStatus.REJECTED, hrDecision: 'REJECTED', notificationSent: false,
            }));
            expect(api.sendMessage).toHaveBeenCalledWith(123, CANDIDATE_TEXTS['worker-offer-rejected'], { parse_mode: 'HTML' });
            expect(candidateRepository.update).toHaveBeenLastCalledWith('cand1', { notificationSent: true });
        });

        it('booked meeting still ahead: releases the slot and sends the general rejection', async () => {
            const { bookingService } = await import('../booking-service.js');
            const startTime = new Date(Date.now() + 3 * 3600_000);
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                ...base, status: CandidateStatus.INTERVIEW_SCHEDULED, interviewSlotId: 'slot1', interviewSlot: { startTime }
            } as any);

            await hrService.rejectAfterInterview(api, 'cand1');

            expect(bookingService.cancelInterviewSlot).toHaveBeenCalledWith('slot1');
            expect(api.sendMessage).toHaveBeenCalledWith(123, CANDIDATE_TEXTS['candidate-rejected'], { parse_mode: 'HTML' });
        });

        it('meeting already started but not auto-completed: keeps the slot, post-interview letter', async () => {
            const { bookingService } = await import('../booking-service.js');
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                ...base, status: CandidateStatus.INTERVIEW_SCHEDULED, interviewSlotId: 'slot1', interviewSlot: { startTime: new Date(Date.now() - 600_000) }
            } as any);

            await hrService.rejectAfterInterview(api, 'cand1');

            expect(bookingService.cancelInterviewSlot).not.toHaveBeenCalled();
            expect(api.sendMessage).toHaveBeenCalledWith(123, CANDIDATE_TEXTS['worker-offer-rejected'], { parse_mode: 'HTML' });
        });

        it('send failure: status stays REJECTED, the command fails with a code', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({ ...base, status: CandidateStatus.INTERVIEW_COMPLETED } as any);
            api.sendMessage.mockRejectedValue(new Error('ETIMEDOUT'));

            await expect(hrService.rejectAfterInterview(api, 'cand1')).rejects.toThrow('REJECTION_NOT_SENT:send_failed');
            expect(candidateRepository.update).not.toHaveBeenCalledWith('cand1', { notificationSent: true });
        });

        it('retry for an already rejected candidate without a letter only sends the letter', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                ...base, status: CandidateStatus.REJECTED, hrDecision: 'REJECTED', notificationSent: false
            } as any);

            await hrService.rejectAfterInterview(api, 'cand1');

            expect(candidateRepository.update).toHaveBeenCalledTimes(1);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', { notificationSent: true });
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
        });

        it('already rejected and notified: nothing is sent twice', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                ...base, status: CandidateStatus.REJECTED, hrDecision: 'REJECTED', notificationSent: true
            } as any);

            await expect(hrService.rejectAfterInterview(api, 'cand1')).resolves.toBe(true);
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(candidateRepository.update).not.toHaveBeenCalled();
        });
    });

    describe('offline staging withdrawal flows', () => {
        const mockApi = {
            sendMessage: vi.fn().mockResolvedValue({})
        };

        it('cancels candidate staging, clears assignment, and notifies the partner (HR sees it in the web inbox)', async () => {
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
            // HR больше не получает телеграм-уведомление про отмену стажування —
            // сигнал уходит только в веб-инбокс через зеркало кандидата.
            expect(mockApi.sendMessage).not.toHaveBeenCalledWith(
                111111,
                expect.anything(),
                expect.anything()
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
        it('с waitlistedBefore зовёт только тех, для кого самый новый слот действительно новый', async () => {
            vi.mocked(candidateRepository.findByStatusWithUser).mockResolvedValue([] as any);
            const since = new Date('2026-09-30T10:00:00.000Z');

            await hrService.notifyWaitlist({ sendMessage: vi.fn() }, { waitlistedBefore: since });

            expect(candidateRepository.findByStatusWithUser).toHaveBeenCalledWith(
                expect.any(Array),
                expect.objectContaining({
                    interviewSlotId: null,
                    AND: [{ OR: [{ interviewWaitlistedAt: null }, { interviewWaitlistedAt: { lt: since } }] }],
                }),
            );
        });

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
                    gender: "female",
                    currentStep: FunnelStep.INTERVIEW,
                    interviewSlotId: null,
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
            // Остаётся в поиске времени до записи и не попадает под 48-часовой
            // сброс приглашения: места ей никто не давал и не забирал.
            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', {
                status: CandidateStatus.SCREENING,
                isWaitlisted: false,
                notificationSent: true,
                interviewWaitlistReason: 'NO_SLOTS_AVAILABLE',
                interviewWaitlistedAt: expect.any(Date),
                interviewInvitedAt: null,
                interviewInviteReminderSentAt: null
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
                gender: 'female',
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

        it('should block interview invite for male candidates', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue({
                id: 'cand-male',
                city: 'Kyiv',
                locationId: 'loc1',
                gender: 'male',
                birthDate: new Date('2004-09-23T00:00:00.000Z'),
                user: { id: 'user-male', telegramId: 456n }
            } as any);

            const api = {
                sendMessage: vi.fn()
            };

            const result = await hrService.inviteCandidate(api, 'cand-male');

            expect(result).toEqual({ ok: false, reason: 'gender_ineligible' });
            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-male', {
                status: CandidateStatus.REJECTED,
                isWaitlisted: false,
                notificationSent: false,
                interviewWaitlistReason: null,
                interviewInvitedAt: null,
                hasUnreadMessage: false,
            });
        });

        const eligibleCandidate = (id: string) => ({
            id,
            city: 'Kyiv',
            locationId: 'loc1',
            gender: 'female',
            birthDate: new Date('2004-09-23T00:00:00.000Z'),
            location: { name: 'Volkland' },
            user: { id: `user-${id}`, telegramId: 789n }
        });

        it('reports a delivery failure when Telegram refuses the invitation', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue(eligibleCandidate('cand-net') as any);
            const api = { sendMessage: vi.fn().mockRejectedValue(new Error('socket hang up')) };

            const result = await hrService.inviteCandidate(api, 'cand-net');

            expect(result).toEqual({ ok: false, reason: 'send_failed' });
        });

        it('reports a bot block instead of a delivery failure when Telegram answers 403', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue(eligibleCandidate('cand-blocked') as any);
            const blocked = Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 });
            const api = { sendMessage: vi.fn().mockRejectedValue(blocked) };

            const result = await hrService.inviteCandidate(api, 'cand-blocked');

            expect(result).toEqual({ ok: false, reason: 'bot_blocked' });
        });

        it('does not disguise a database failure as a delivery failure once the invitation is sent', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue(eligibleCandidate('cand-db') as any);
            vi.mocked(candidateRepository.update).mockRejectedValue(new Error('write conflict'));
            const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

            const result = await hrService.inviteCandidate(api, 'cand-db');

            expect(api.sendMessage).toHaveBeenCalled();
            expect(result).toEqual({ ok: false, reason: 'state_write_failed' });
        });

        // 30.09.2026: вебапп (зі стадією на 19 годин позаду) надіслав запрошення
        // кандидатці, яка вже була записана на 15:15. Бот спершу відправляв
        // «Анкету розглянуто, оберіть час», а потім падав на записі стану —
        // і кожен повтор команди слав те саме повідомлення знову (три рази).
        it('does not send an invitation the funnel would refuse to record', async () => {
            vi.mocked(candidateRepository.findById).mockResolvedValue(eligibleCandidate('cand-booked') as any);
            vi.mocked(candidateRepository.checkFunnelPatch).mockResolvedValueOnce(
                new Error('Transition INTERVIEW_SCHEDULED -> SCREENING is not allowed') as any,
            );
            const api = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };

            const result = await hrService.inviteCandidate(api, 'cand-booked');

            expect(api.sendMessage).not.toHaveBeenCalled();
            expect(candidateRepository.update).not.toHaveBeenCalled();
            expect(result).toEqual({ ok: false, reason: 'state_conflict' });
            // Вебапп бачив застарілу стадію — пуш дзеркала її виправляє.
            expect(candidateRepository.requestMirrorPush).toHaveBeenCalledWith('cand-booked');
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
