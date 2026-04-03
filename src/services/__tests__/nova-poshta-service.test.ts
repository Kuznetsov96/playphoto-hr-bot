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

    const possibilityResponse = {
        success: true,
        data: [{
            CanChangeSender: true,
            CanChangeRecipient: true,
            CanChangePayerTypeOrPaymentMethod: true,
            CanChangeBackwardDeliveryDocuments: true,
            CanChangeBackwardDeliveryMoney: true,
            CanChangeCash2Card: true,
            CanChangeBackwardDeliveryOther: true,
            CanChangeAfterpaymentType: true,
            CanChangeLiftingOnFloor: true,
            CanChangeLiftingOnFloorWithElevator: true,
            CanChangeFillingWarranty: true,
            SenderCounterparty: 'sender-ref',
            ContactPersonSender: 'Катерина Посреднікова',
            SenderPhone: '380633880432',
            RecipientCounterparty: '00000000-0000-0000-0000-000000000000',
            ContactPersonRecipient: 'Старий Отримувач',
            RecipientPhone: '380633880432',
            PayerType: 'Recipient',
            PaymentMethod: 'Cash'
        }],
        errors: [],
        warnings: [],
        info: []
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('checks possibility first and then uses orderChangeEW with returned fields', async () => {
        fetchMock
            .mockResolvedValueOnce({ json: async () => possibilityResponse })
            .mockResolvedValueOnce({
                json: async () => ({ success: true, data: [{ Number: '102-00006096', Ref: 'ref-123' }] })
            });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850', 'Ворош Яна Павлівна')).resolves.toEqual({
            success: true,
            orderNumber: '102-00006096',
            orderRef: 'ref-123',
            method: 'orderChangeEW'
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(getRequestBody(0)).toMatchObject({
            modelName: 'AdditionalServiceGeneral',
            calledMethod: 'CheckPossibilityChangeEW',
            methodProperties: {
                IntDocNumber: '20451403292435'
            }
        });
        expect(getRequestBody(1)).toMatchObject({
            modelName: 'AdditionalServiceGeneral',
            calledMethod: 'save',
            methodProperties: {
                OrderType: 'orderChangeEW',
                IntDocNumber: '20451403292435',
                PaymentMethod: 'Cash',
                SenderContactName: 'Катерина Посреднікова',
                SenderPhone: '380633880432',
                Recipient: '00000000-0000-0000-0000-000000000000',
                RecipientContactName: 'Ворош Яна Павлівна',
                RecipientPhone: '380737588850',
                PayerType: 'Recipient'
            }
        });
    });

    it('returns shipment locked when possibility says recipient change is not allowed', async () => {
        fetchMock.mockResolvedValue({
            json: async () => ({
                ...possibilityResponse,
                data: [{ ...possibilityResponse.data[0], CanChangeRecipient: false }]
            })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toEqual({
            success: false,
            errorCode: 'SHIPMENT_LOCKED',
            errorMessage: 'Nova Poshta does not allow changing the recipient for this shipment',
            method: 'checkPossibilityChangeEW'
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns api error when possibility check itself fails', async () => {
        fetchMock.mockResolvedValue({
            json: async () => ({ success: false, errors: ['possibility failed'] })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toEqual({
            success: false,
            errorCode: 'API_ERROR',
            errorMessage: 'possibility failed',
            method: 'checkPossibilityChangeEW'
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns not_document_owner when orderChangeEW fails with ownership error', async () => {
        fetchMock
            .mockResolvedValueOnce({ json: async () => possibilityResponse })
            .mockResolvedValueOnce({
                json: async () => ({ success: false, errors: ['Документ не належить даному користувачу'] })
            });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850', 'Ворош Яна Павлівна')).resolves.toEqual({
            success: false,
            errorCode: 'NOT_DOCUMENT_OWNER',
            errorMessage: 'Документ не належить даному користувачу',
            method: 'orderChangeEW'
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns not_document_owner when possibility check rejects ownership', async () => {
        fetchMock.mockResolvedValue({
            json: async () => ({ success: false, errors: ['Документ не належить даному користувачу'] })
        });

        const { NovaPoshtaService } = await import('../nova-poshta-service.js');
        const service = new NovaPoshtaService();

        await expect(service.createTrustee('20451403292435', '380737588850')).resolves.toEqual({
            success: false,
            errorCode: 'NOT_DOCUMENT_OWNER',
            errorMessage: 'Документ не належить даному користувачу',
            method: 'checkPossibilityChangeEW'
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
