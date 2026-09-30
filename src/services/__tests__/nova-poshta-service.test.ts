import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const loggerMock = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
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

/**
 * Трекинг без телефона — штатный режим: у посылок сети разные получатели. НП
 * отвечает на это предупреждением по каждой посылке, и в warn оно прятало
 * настоящие предупреждения рядом.
 */
describe('NovaPoshtaService warnings', () => {
    const PHONE = 'Please enter a valid phone number from the express invoice to show full information';

    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('keeps the tracking result and does not warn about tracking without a phone', async () => {
        fetchMock.mockResolvedValueOnce({
            json: async () => ({
                success: true,
                data: [{ Number: '20450000000001', StatusCode: '7' }],
                errors: [],
                warnings: [{ ID_20450000000001: PHONE }, { ID_20450000000002: PHONE }],
                info: [],
            }),
        });
        const { NovaPoshtaService } = await import('../nova-poshta-service.js');

        const result = await new NovaPoshtaService().trackParcels([{ DocumentNumber: '20450000000001', Phone: '' }]);

        expect(result).toEqual([{ Number: '20450000000001', StatusCode: '7' }]);
        expect(loggerMock.warn).not.toHaveBeenCalled();
    });

    it('still warns about anything else, without the expected ones', async () => {
        fetchMock.mockResolvedValueOnce({
            json: async () => ({
                success: true,
                data: [],
                errors: [],
                warnings: [{ ID_1: PHONE }, { ID_2: 'Document not found' }],
                info: [],
            }),
        });
        const { NovaPoshtaService } = await import('../nova-poshta-service.js');

        await new NovaPoshtaService().trackParcels([{ DocumentNumber: '1', Phone: '' }]);

        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        const [context] = loggerMock.warn.mock.calls[0]!;
        expect(context.safeContext).toMatchObject({ warningsCount: 1, warnings: [{ ID_2: 'Document not found' }] });
    });

    it('recognises the expected warning in both shapes NP uses', async () => {
        const { isExpectedNpWarning } = await import('../nova-poshta-service.js');

        expect(isExpectedNpWarning({ ID_1: PHONE })).toBe(true);
        expect(isExpectedNpWarning(PHONE)).toBe(true);
        expect(isExpectedNpWarning({ ID_1: 'Document not found' })).toBe(false);
        expect(isExpectedNpWarning({})).toBe(false);
    });
});

