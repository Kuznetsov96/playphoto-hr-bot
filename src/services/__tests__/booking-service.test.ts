import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunnelStep } from '@prisma/client';
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
        findSlotWithCandidate: vi.fn(),
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

        it('should throw error for underage candidate even with valid slot', async () => {
            const txMock = {};
            const now = new Date();
            const underageBirthDate = new Date(now.getFullYear() - 16, now.getMonth(), now.getDate());

            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(interviewRepository.findSlotById).mockResolvedValue({ id: 'slot1', isBooked: false } as any);
            vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue({
                id: 'cand1',
                status: 'SCREENING',
                hrDecision: null,
                birthDate: underageBirthDate
            } as any);

            await expect(bookingService.bookInterviewSlot(12345, 'slot1', 'user'))
                .rejects.toThrow('UNDERAGE_CANDIDATE');
        });

        it('should throw error for age-limit candidate even with valid slot', async () => {
            const txMock = {};

            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(interviewRepository.findSlotById).mockResolvedValue({ id: 'slot1', isBooked: false } as any);
            vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue({
                id: 'cand-age',
                status: 'SCREENING',
                hrDecision: null,
                birthDate: new Date('1994-09-23T00:00:00.000Z')
            } as any);

            await expect(bookingService.bookInterviewSlot(12345, 'slot1', 'user'))
                .rejects.toThrow('AGE_LIMIT_CANDIDATE');
        });

        it('should reactivate stale underage rejection when candidate is now eligible', async () => {
            const startTime = new Date('2026-04-12T10:00:00.000Z');
            const endTime = new Date('2026-04-12T10:30:00.000Z');
            const txMock = {};
            const candidate = {
                id: 'cand-reactivate',
                status: 'REJECTED',
                hrDecision: 'REJECTED_SYSTEM_UNDERAGE',
                gender: 'female',
                fullName: 'Test Candidate',
                birthDate: new Date('2009-04-12T00:00:00.000Z'),
                city: 'Київ',
                locationId: 'loc-1',
                appearance: 'Без особливостей',
                source: 'Instagram',
                location: { neededCount: 1, isHidden: false, isHiddenFromCandidates: false },
                user: { telegramId: 12345n },
            };

            vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(txMock));
            vi.mocked(interviewRepository.findSlotById).mockResolvedValue({ id: 'slot1', isBooked: false } as any);
            vi.mocked(candidateRepository.findByTelegramId).mockResolvedValue(candidate as any);
            vi.mocked(candidateRepository.update)
                .mockResolvedValueOnce({ ...candidate, status: 'SCREENING', hrDecision: null } as any)
                .mockResolvedValue({} as any);
            vi.mocked(interviewRepository.updateSlot).mockResolvedValue({
                id: 'slot1',
                startTime,
                endTime,
                candidate: { fullName: 'Test Candidate' }
            } as any);
            vi.mocked(googleCalendar.createInterviewEvent).mockResolvedValue({ meetLink: 'http://meet' } as any);

            await bookingService.bookInterviewSlot(12345, 'slot1', 'user');

            expect(candidateRepository.update).toHaveBeenNthCalledWith(1, 'cand-reactivate', expect.objectContaining({
                status: 'SCREENING',
                hrDecision: null,
            }), txMock);
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-reactivate', { status: 'INTERVIEW_SCHEDULED' }, txMock);
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

    describe('cancelInterviewSlot', () => {
        it('realigns legacy interview records to the interview step while disconnecting the slot', async () => {
            vi.mocked(interviewRepository.findSlotWithCandidate).mockResolvedValue({
                id: 'slot1',
                googleEventId: null,
                candidate: {
                    id: 'cand1',
                    user: { telegramId: 12345n }
                }
            } as any);

            await bookingService.cancelInterviewSlot('slot1');

            expect(candidateRepository.update).toHaveBeenCalledWith('cand1', {
                googleMeetLink: null,
                interviewSlot: { disconnect: true },
                currentStep: FunnelStep.INTERVIEW,
            });
            expect(interviewRepository.updateSlot).toHaveBeenCalledWith('slot1', {
                isBooked: false,
                candidate: { disconnect: true },
                googleEventId: null
            });
        });
    });

    describe('cancelTrainingSlot', () => {
        it('realigns mentor-stage records to the training step while disconnecting both slot types', async () => {
            vi.mocked(trainingRepository.findSlotWithCandidate).mockResolvedValue({
                id: 'tslot1',
                googleEventId: null,
                candidate: {
                    id: 'cand-training',
                    user: { telegramId: 111n }
                },
                candidateDiscovery: {
                    id: 'cand-discovery',
                    user: { telegramId: 222n }
                }
            } as any);

            await bookingService.cancelTrainingSlot('tslot1');

            expect(candidateRepository.update).toHaveBeenCalledWith('cand-training', {
                trainingMeetLink: null,
                trainingSlot: { disconnect: true },
                currentStep: FunnelStep.TRAINING,
            });
            expect(candidateRepository.update).toHaveBeenCalledWith('cand-discovery', {
                trainingMeetLink: null,
                discoverySlot: { disconnect: true },
                currentStep: FunnelStep.TRAINING,
            });
            expect(trainingRepository.updateSlot).toHaveBeenCalledWith('tslot1', {
                isBooked: false,
                candidate: { disconnect: true },
                candidateDiscovery: { disconnect: true },
                googleEventId: null
            });
        });
    });

    describe('slot ownership guards', () => {
        it('blocks interview slot cancellation for another candidate', async () => {
            vi.mocked(interviewRepository.findSlotWithCandidate).mockResolvedValue({
                id: 'slot1',
                candidate: {
                    id: 'cand1',
                    user: { telegramId: BigInt(999999) }
                }
            } as any);

            await expect(bookingService.cancelInterviewSlot('slot1', 123456))
                .rejects.toThrow('FORBIDDEN_SLOT_ACCESS');
        });

        it('blocks training slot cancellation for another discovery candidate', async () => {
            vi.mocked(trainingRepository.findSlotWithCandidate).mockResolvedValue({
                id: 'slot2',
                candidateDiscovery: {
                    id: 'disc1',
                    user: { telegramId: BigInt(999999) }
                }
            } as any);

            await expect(bookingService.cancelTrainingSlot('slot2', 123456))
                .rejects.toThrow('FORBIDDEN_SLOT_ACCESS');
        });
    });
});
