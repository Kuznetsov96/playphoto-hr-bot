import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BookingService } from '../booking-service.js';
import prisma from '../../db/core.js';
import { googleCalendar } from '../google-calendar.js';
import { interviewRepository } from '../../repositories/interview-repository.js';
import { trainingRepository } from '../../repositories/training-repository.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';

// Mock dependencies
vi.mock('../../db/core.js', () => ({
    default: {
        $transaction: vi.fn((cb) => cb({
            interviewSlot: {
                findUnique: vi.fn(),
                update: vi.fn()
            },
            candidate: {
                findFirst: vi.fn(),
                update: vi.fn()
            },
            trainingSlot: {
                findUnique: vi.fn(),
                update: vi.fn()
            }
        }))
    }
}));

vi.mock('../google-calendar.js', () => ({
    googleCalendar: {
        createInterviewEvent: vi.fn(),
        createEvent: vi.fn(),
        deleteEvent: vi.fn()
    }
}));

vi.mock('../../repositories/interview-repository.js', () => ({
    interviewRepository: {
        findSlotWithCandidate: vi.fn(),
        updateSlot: vi.fn(),
        findSlotById: vi.fn()
    }
}));

vi.mock('../../repositories/training-repository.js', () => ({
    trainingRepository: {
        findSlotById: vi.fn(),
        updateSlot: vi.fn()
    }
}));

vi.mock('../../repositories/candidate-repository.js', () => ({
    candidateRepository: {
        update: vi.fn(),
        findByTelegramId: vi.fn()
    }
}));

describe('BookingService', () => {
    let bookingService: BookingService;

    beforeEach(() => {
        vi.clearAllMocks();
        bookingService = new BookingService();
    });

    describe('bookInterviewSlot', () => {
        it('should throw error if slot is already booked', async () => {
            const txMock = {};
            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(interviewRepository.findSlotById).mockResolvedValue({ isBooked: true } as any);

            await expect(bookingService.bookInterviewSlot(12345, 'slot1', 'user'))
                .rejects.toThrow('ALREADY_BOOKED');
        });

        it('should successfully book a slot and create google event', async () => {
            const startTime = new Date();
            const endTime = new Date();
            const txMock = {};

            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(interviewRepository.findSlotById).mockResolvedValue({ id: 'slot1', isBooked: false } as any);
            vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue({ id: 'cand1', FullName: 'Ivanov' } as any);
            vi.mocked(interviewRepository.updateSlot).mockResolvedValue({
                id: 'slot1',
                startTime,
                endTime,
                candidate: { fullName: 'Ivanov' }
            } as any);
            vi.mocked(googleCalendar.createInterviewEvent).mockResolvedValue({ meetLink: 'http://meet' } as any);

            const result = await bookingService.bookInterviewSlot(12345, 'slot1', 'user');

            expect(interviewRepository.updateSlot).toHaveBeenCalledWith('slot1', expect.objectContaining({
                isBooked: true
            }), txMock);
            expect(googleCalendar.createInterviewEvent).toHaveBeenCalled();
            expect(result.googleEvent.meetLink).toBe('http://meet');
        });
    });

    describe('bookTrainingSlot', () => {
        it('should throw error if candidate not found', async () => {
            const txMock = {};
            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(trainingRepository.findSlotById).mockResolvedValue({ id: 'tslot1', isBooked: false } as any);
            vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue(null);

            await expect(bookingService.bookTrainingSlot(12345, 'tslot1'))
                .rejects.toThrow('CANDIDATE_NOT_FOUND');
        });

        it('should successfully book a training slot', async () => {
            const txMock = {};
            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(trainingRepository.findSlotById).mockResolvedValue({ id: 'tslot1', isBooked: false, startTime: new Date(), endTime: new Date() } as any);
            vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue({ id: 'cand1' } as any);
            vi.mocked(trainingRepository.updateSlot).mockResolvedValue({ id: 'tslot1', isBooked: true, candidate: { fullName: 'Ivanov' } } as any);
            vi.mocked(googleCalendar.createEvent).mockResolvedValue({ meetLink: 'http://meet', eventId: 'ev1' } as any);

            const result = await bookingService.bookTrainingSlot(12345, 'tslot1');

            expect(trainingRepository.updateSlot).toHaveBeenCalled();
            expect(result.id).toBe('tslot1');
        });
    });
});
