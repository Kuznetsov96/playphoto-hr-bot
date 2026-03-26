import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InterviewService } from '../interview-service.js';
import { interviewRepository } from '../../repositories/interview-repository.js';

// Mock repository
vi.mock('../../repositories/interview-repository.js', () => ({
    interviewRepository: {
        createSession: vi.fn(),
        createSlot: vi.fn(),
        findActiveSlots: vi.fn(),
        findAllSessions: vi.fn(),
        findFirstOverlap: vi.fn(),
        deleteUnbookedSlots: vi.fn(),
        updateSessionHeader: vi.fn()
    }
}));

// Mock Prisma
vi.mock('../../db/core.js', () => ({
    default: {
        interviewSlot: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 })
        }
    }
}));

describe('InterviewService', () => {
    let interviewService: InterviewService;

    beforeEach(() => {
        vi.clearAllMocks();
        interviewService = new InterviewService();
    });

    describe('createSessionWithSlots', () => {
        it('should throw error if end time is before start time', async () => {
            const start = new Date('2026-02-10T10:00:00');
            const end = new Date('2026-02-10T09:00:00');
            await expect(interviewService.createSessionWithSlots(start, end))
                .rejects.toThrow('End time must be after start time');
        });

        it('should create correct number of slots', async () => {
            const start = new Date('2026-02-10T10:00:00');
            const end = new Date('2026-02-10T11:00:00'); // 60 mins -> 4 slots of 15 mins

            vi.mocked(interviewRepository.createSession).mockResolvedValue({ id: 'session1' } as any);
            vi.mocked(interviewRepository.createSlot).mockResolvedValue({ id: 'slot' } as any);

            const result = await interviewService.createSessionWithSlots(start, end);

            expect(interviewRepository.createSession).toHaveBeenCalledWith({ startTime: start, endTime: end });
            expect(interviewRepository.createSlot).toHaveBeenCalledTimes(4);
            expect(result.createdCount).toBe(4);
        });

        it('should handle non-exact divisions (break before end)', async () => {
            const start = new Date('2026-02-10T10:00:00');
            const end = new Date('2026-02-10T10:35:00'); // 35 mins -> 2 slots of 15 mins

            vi.mocked(interviewRepository.createSession).mockResolvedValue({ id: 'session1' } as any);
            vi.mocked(interviewRepository.createSlot).mockResolvedValue({ id: 'slot' } as any);

            const result = await interviewService.createSessionWithSlots(start, end);

            expect(interviewRepository.createSlot).toHaveBeenCalledTimes(2);
            expect(result.createdCount).toBe(2);
        });
    });

    describe('createSingleSlot', () => {
        it('should create a session and then a slot', async () => {
            const start = new Date('2026-02-10T10:00:00');
            vi.mocked(interviewRepository.createSession).mockResolvedValue({ id: 'session2' } as any);
            vi.mocked(interviewRepository.createSlot).mockResolvedValue({ id: 'slot2' } as any);

            await interviewService.createSingleSlot(start);

            expect(interviewRepository.createSession).toHaveBeenCalled();
            expect(interviewRepository.createSlot).toHaveBeenCalledWith(expect.objectContaining({
                sessionId: 'session2'
            }));
        });
    });
});
