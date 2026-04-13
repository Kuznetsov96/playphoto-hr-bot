import { beforeEach, describe, expect, it, vi } from 'vitest';

const prismaMock = {
    location: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
    },
    parcel: {
        findFirst: vi.fn(),
    },
};

vi.mock('../../db/core.js', () => ({
    default: prismaMock,
}));

vi.mock('../nova-poshta-service.js', () => ({
    novaPoshtaService: {},
}));

vi.mock('../../core/logger.js', () => ({
    default: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('../../core/log-events.js', () => ({
    logBusinessEvent: vi.fn(),
}));

vi.mock('../../utils/signed-callback.js', () => ({
    buildSignedCallback: vi.fn(() => 'signed-callback'),
}));

vi.mock('../../config.js', () => ({
    BOT_TOKEN: 'test-bot-token',
    TEAM_CHATS: { SUPPORT: -100123, LOGISTICS: 42 },
    NP_RECIPIENT_PHONE: '380000000000',
}));

vi.mock('grammy', () => {
    class InlineKeyboard {
        text() { return this; }
        row() { return this; }
        url() { return this; }
    }

    class Bot {
        api = {
            sendMessage: vi.fn(),
            sendPhoto: vi.fn(),
            sendMediaGroup: vi.fn(),
        };

        constructor(_token: string) { }
    }

    return { Bot, InlineKeyboard };
});

describe('LogisticsService.findLocationByMapping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.parcel.findFirst.mockResolvedValue(null);
        prismaMock.location.findFirst.mockResolvedValue(null);
        prismaMock.location.findMany.mockResolvedValue([]);
    });

    it('does not map Lviv warehouse 6 to Volkland and falls back to fuzzy address match', async () => {
        const driveCity = {
            id: 'drive-city-id',
            name: 'Drive City',
            legacyName: null,
            city: 'Львів',
            address: 'Львів, вул. Сихівська 16а',
            isHidden: false,
        };

        prismaMock.location.findFirst.mockResolvedValue(driveCity);

        const { LogisticsService } = await import('../logistics-service.js');
        const service = new LogisticsService();

        const result = await (service as any).findLocationByMapping(
            null,
            'Львів',
            '6',
            'м. Львів, Відділення №6 (до 10 кг): вул. Сихівська, 8'
        );

        expect(result).toEqual(driveCity);
        expect(prismaMock.location.findFirst).toHaveBeenCalledTimes(1);
    });

    it('keeps city-specific warehouse mapping when city matches', async () => {
        const volkland = {
            id: 'volkland-1-id',
            name: 'Volkland',
            legacyName: 'Volkland 1 (Бабурка)',
            city: 'Запоріжжя',
            address: 'Запоріжжя, Інженера Преображенського 13',
            isHidden: false,
        };

        prismaMock.location.findFirst.mockResolvedValue(volkland);

        const { LogisticsService } = await import('../logistics-service.js');
        const service = new LogisticsService();

        const result = await (service as any).findLocationByMapping(
            null,
            'Запоріжжя',
            '6',
            'м. Запоріжжя, Відділення №6'
        );

        expect(result).toEqual(volkland);
        expect(prismaMock.location.findFirst).toHaveBeenCalledTimes(1);
    });
});