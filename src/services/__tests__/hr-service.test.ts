import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hrService } from '../hr-service.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';
import { interviewRepository } from '../../repositories/interview-repository.js';
import { locationRepository } from '../../repositories/location-repository.js';
import { CandidateStatus } from '@prisma/client';

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

vi.mock('../access-service.js', () => ({
    accessService: {
        syncUserAccess: vi.fn().mockResolvedValue({})
    }
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

            const stats = await hrService.getHubStats();

            expect(stats.newCandidates).toBe(5);
            expect(stats.todayInterviews).toBe(3);
            expect(stats.hiredWeek).toBe(2);
            // inboxTotal = tattooCount(1) + unreadCount(4) + noSlotCount(5) + finalStepStats.total(6) = 16
            expect(stats.inboxTotal).toBe(16);
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
                hrDecision: 'REJECTED',
                notificationSent: false,
                materialsSent: false,
                hasUnreadMessage: false
            });
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
});
