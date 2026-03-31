import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('node-fetch', () => ({
    default: fetchMock
}));

vi.mock('../../core/logger.js', () => ({
    default: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));

vi.mock('../../config.js', () => ({
    NOVA_POSHTA_API_KEY: 'test-api-key',
    NP_RECIPIENT_PHONE: '+380991112233'
}));

describe('NovaPoshtaService.createTrustee', () => {
    const getRequestBody = (callIndex: number) => {
        const options = fetchMock.mock.calls[callIndex]?.[1] as { body?: string } | undefined;
        expect(options?.body).toBeTruthy();
        return JSON.parse(options!.body!);
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('uses orderChangeEW as the primary flow', async () => {
        fetchMock.mockResolvedValue({
            json: async () => ({ success: true, data: [{}] })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(getRequestBody(0)).toMatchObject({
            modelName: 'AdditionalServiceGeneral',
            calledMethod: 'save',
            methodProperties: {
                OrderType: 'orderChangeEW',
                IntDocNumber: '20451403292435',
                RecipientPhone: '380737588850',
                PayerType: 'Recipient',
                PaymentMethod: 'Cash'
            }
        });
    });

    it('falls back to orderTrustee when orderChangeEW fails', async () => {
        fetchMock
            .mockResolvedValueOnce({
                json: async () => ({ success: false, errors: ['primary failed'] })
            })
            .mockResolvedValueOnce({
                json: async () => ({ success: true, data: [{}] })
            });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(getRequestBody(1)).toMatchObject({
            modelName: 'AdditionalService',
            calledMethod: 'save',
            methodProperties: {
                OrderType: 'orderTrustee',
                IntDocNumber: '20451403292435',
                CustomerPhone: '380991112233',
                TrusteePhone: '380737588850'
            }
        });
    });

    it('returns false when both trustee creation methods fail', async () => {
        fetchMock
            .mockResolvedValueOnce({
                json: async () => ({ success: false, errors: ['primary failed'] })
            })
            .mockResolvedValueOnce({
                json: async () => ({ success: false, errors: ['fallback failed'] })
            });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
