import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const loggerMock = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn()
};

vi.mock('node-fetch', () => ({
    default: fetchMock
}));

vi.mock('../../core/logger.js', () => ({
    default: loggerMock
}));

vi.mock('../../config.js', () => ({
    NOVA_POSHTA_API_KEY: 'test-api-key'
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
            json: async () => ({ success: true, data: [{ Number: '102-00006096', Ref: 'ref-123' }] })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toEqual({
            success: true,
            orderNumber: '102-00006096',
            orderRef: 'ref-123'
        });

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

    it('returns a locked result when Nova Poshta forbids recipient changes', async () => {
        fetchMock.mockResolvedValue({
            json: async () => ({
                success: false,
                errors: ['The shipment has been delivered to the recipient. Further data changes are not possible']
            })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toEqual({
            success: false,
            errorCode: 'SHIPMENT_LOCKED',
            errorMessage: 'The shipment has been delivered to the recipient. Further data changes are not possible'
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(loggerMock.error).toHaveBeenCalledTimes(1);
        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                ttn: '20451403292435',
                errorCode: 'SHIPMENT_LOCKED'
            }),
            'Nova Poshta trustee creation failed'
        );
    });

    it('returns an api error result when trustee creation fails for another reason', async () => {
        fetchMock.mockResolvedValue({
            json: async () => ({ success: false, errors: ['primary failed'] })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toEqual({
            success: false,
            errorCode: 'API_ERROR',
            errorMessage: 'primary failed'
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
