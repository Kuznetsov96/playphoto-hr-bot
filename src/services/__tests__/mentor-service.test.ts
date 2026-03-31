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
        trainingSlot: { count: vi.fn().mockResolvedValue(0) }
    }
}));

vi.mock('../../repositories/candidate-repository.js', () => ({
    candidateRepository: {
        findById: vi.fn(),
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
        countBookedSlotsByDateRange: vi.fn().mockResolvedValue(0)
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
        "discovery-invite": () => "Test discovery invite text"
    }
}));

vi.mock('../../repositories/timeline-repository.js', () => ({
    timelineRepository: { createEvent: vi.fn() }
}));

import { mentorService } from '../mentor-service.js';
import { candidateRepository } from '../../repositories/candidate-repository.js';

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
    });

    describe('notifyWaitlist', () => {
        it('should skip candidates with currentStep != TRAINING', async () => {
            vi.mocked(candidateRepository.findByStatus).mockResolvedValue([
                {
                    id: 'cand-hr',
                    status: CandidateStatus.WAITLIST,
                    currentStep: FunnelStep.INITIAL_TEST,
                    isWaitlisted: true,
                    hrDecision: null,
                    user: { telegramId: 111n }
                } as any,
                {
                    id: 'cand-mentor',
                    status: CandidateStatus.WAITLIST,
                    currentStep: FunnelStep.TRAINING,
                    isWaitlisted: true,
                    hrDecision: 'ACCEPTED',
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
    });
});
