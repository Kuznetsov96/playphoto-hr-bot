import fetch from 'node-fetch';
import { NOVA_POSHTA_API_KEY } from '../config.js';
import logger from '../core/logger.js';

export interface NPTrackingResult {
    Number: string;
    Status: string;
    StatusCode: string;
    WarehouseRecipient: string;
    WarehouseRecipientRef: string;
    RecipientAddress: string;
    RecipientAddressRef: string;
    ScheduledDeliveryDate: string;
    ActualDeliveryDate: string;
    RecipientDateTime: string;
}

export type NPTrusteeErrorCode = 'SHIPMENT_LOCKED' | 'NOT_DOCUMENT_OWNER' | 'API_ERROR';

export interface NPChangePossibilityResult {
    CanChangeSender: boolean;
    CanChangeRecipient: boolean;
    CanChangePayerTypeOrPaymentMethod: boolean;
    CanChangeBackwardDeliveryDocuments: boolean;
    CanChangeBackwardDeliveryMoney: boolean;
    CanChangeCash2Card: boolean;
    CanChangeBackwardDeliveryOther: boolean;
    CanChangeAfterpaymentType: boolean;
    CanChangeLiftingOnFloor: boolean;
    CanChangeLiftingOnFloorWithElevator: boolean;
    CanChangeFillingWarranty: boolean;
    SenderCounterparty?: string;
    ContactPersonSender?: string;
    SenderPhone?: string;
    RecipientCounterparty?: string;
    ContactPersonRecipient?: string;
    RecipientPhone?: string;
    PayerType?: string;
    PaymentMethod?: string;
}

export interface NPTrusteeCreationResult {
    success: boolean;
    errorCode?: NPTrusteeErrorCode;
    errorMessage?: string;
    orderRef?: string;
    orderNumber?: string;
    method?: 'checkPossibilityChangeEW' | 'orderChangeEW';
}

interface NPApiResponseEnvelope<T = any> {
    success: boolean;
    data: T | null;
    errors: string[];
    warnings: string[];
    info: string[];
}

export class NovaPoshtaService {
    private readonly apiUrl = 'https://api.novaposhta.ua/v2.0/json/';

    private isShipmentLockedError(message: string): boolean {
        const loweredError = message.toLowerCase();
        return loweredError.includes('further data changes are not possible') ||
            loweredError.includes('delivered to the recipient');
    }

    private isOwnershipError(message: string): boolean {
        const loweredError = message.toLowerCase();
        return loweredError.includes('документ не належить даному користувачу') ||
            loweredError.includes('документ не належить користувачу') ||
            loweredError.includes('document does not belong to this user');
    }

    private classifyError(message: string): NPTrusteeErrorCode {
        if (this.isShipmentLockedError(message)) {
            return 'SHIPMENT_LOCKED';
        }

        if (this.isOwnershipError(message)) {
            return 'NOT_DOCUMENT_OWNER';
        }

        return 'API_ERROR';
    }

    private getPrimaryErrorMessage<T>(result: NPApiResponseEnvelope<T>): string {
        return result.errors[0] || result.info[0] || result.warnings[0] || 'Unknown API error';
    }

    /**
     * Common method to call NP API
     */
    private async callApiDetailed<T = any>(modelName: string, calledMethod: string, methodProperties: any = {}): Promise<NPApiResponseEnvelope<T>> {
        const body = {
            apiKey: NOVA_POSHTA_API_KEY,
            modelName,
            calledMethod,
            methodProperties
        };

        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' }
            });

            const data: any = await response.json();

            if (!data.success) {
                logger.error({
                    modelName,
                    calledMethod,
                    safeContext: {
                        errorsCount: data.errors?.length || 0,
                        warningsCount: data.warnings?.length || 0,
                        infoCount: data.info?.length || 0,
                        errors: (data.errors || []).slice(0, 3),
                        warnings: (data.warnings || []).slice(0, 3),
                        info: (data.info || []).slice(0, 3)
                    }
                }, 'Nova Poshta API request failed');
                return {
                    success: false,
                    data: null,
                    errors: data.errors || [],
                    warnings: data.warnings || [],
                    info: data.info || []
                };
            }

            if (data.warnings && data.warnings.length > 0) {
                logger.warn({
                    modelName,
                    calledMethod,
                    safeContext: {
                        warningsCount: data.warnings.length,
                        warnings: data.warnings.slice(0, 3),
                        info: (data.info || []).slice(0, 3)
                    }
                }, 'Nova Poshta API returned warnings');
            }

            return {
                success: true,
                data: data.data,
                errors: data.errors || [],
                warnings: data.warnings || [],
                info: data.info || []
            };
        } catch (error) {
            logger.error({ err: error, modelName, calledMethod }, 'Nova Poshta API network request failed');
            return {
                success: false,
                data: null,
                errors: error instanceof Error ? [error.message] : ['Unknown network error'],
                warnings: [],
                info: []
            };
        }
    }

    async callApi(modelName: string, calledMethod: string, methodProperties: any = {}) {
        const result = await this.callApiDetailed(modelName, calledMethod, methodProperties);
        return result.success ? result.data : null;
    }

    /**
     * Track TTNs
     */
    async trackParcels(documents: { DocumentNumber: string; Phone: string }[]): Promise<NPTrackingResult[] | null> {
        const results = await this.callApi('TrackingDocument', 'getStatusDocuments', {
            Documents: documents
        });
        return results;
    }

    /**
     * Get documents for the last X days
     */
    async getIncomingParcels(dateFrom: string, dateTo: string, recipientRef?: string): Promise<any[] | null> {
        // Use getDocumentList which is more reliable and supports full list (incoming/outgoing)
        const methodProperties: any = {
            DateTimeFrom: dateFrom,
            DateTimeTo: dateTo,
            GetFullList: "1"
        };

        if (recipientRef) {
            methodProperties.RecipientRef = recipientRef;
        }

        const results = await this.callApi('InternetDocument', 'getDocumentList', methodProperties);

        if (!results || !Array.isArray(results)) return results;

        return results;
    }

    /**
     * Get incoming parcels by recipient phone (auto-discovery)
     */
    async getIncomingByPhone(phone: string, dateFrom: string, dateTo: string): Promise<any[] | null> {
        const results = await this.callApi('InternetDocument', 'getIncomingDocumentsByPhone', {
            PhoneRecipient: phone,
            DateTimeFrom: dateFrom,
            DateTimeTo: dateTo
        });

        // API returns [{result: [...]}] wrapper
        if (results && Array.isArray(results) && results[0]?.result) {
            return results[0].result;
        }
        return results;
    }

    /**
     * Get list of warehouses for a city (useful for manual mapping/lookup)
     */
    async getWarehouses(cityRef: string): Promise<any[] | null> {
        return this.callApi('Address', 'getWarehouses', { CityRef: cityRef });
    }

    async checkPossibilityChangeEW(ttn: string): Promise<NPApiResponseEnvelope<NPChangePossibilityResult[]>> {
        const result = await this.callApiDetailed<NPChangePossibilityResult[]>('AdditionalServiceGeneral', 'CheckPossibilityChangeEW', {
            IntDocNumber: ttn
        });

        if (result.success) {
            const firstRecord = Array.isArray(result.data) ? result.data[0] : null;
            logger.info({
                ttn,
                method: 'CheckPossibilityChangeEW',
                canChangeRecipient: firstRecord?.CanChangeRecipient ?? null,
                canChangeSender: firstRecord?.CanChangeSender ?? null,
                payerType: firstRecord?.PayerType ?? null,
                paymentMethod: firstRecord?.PaymentMethod ?? null,
                senderCounterparty: firstRecord?.SenderCounterparty ?? null,
                recipientCounterparty: firstRecord?.RecipientCounterparty ?? null
            }, 'Nova Poshta change possibility checked');
        } else {
            logger.warn({
                ttn,
                method: 'CheckPossibilityChangeEW',
                errorMessage: this.getPrimaryErrorMessage(result)
            }, 'Nova Poshta change possibility check failed');
        }

        return result;
    }

    private async tryOrderChangeEW(
        ttn: string,
        recipientPhone: string,
        recipientName: string | undefined,
        possibility: NPChangePossibilityResult
    ): Promise<NPTrusteeCreationResult> {
        const methodProperties: Record<string, string> = {
            OrderType: 'orderChangeEW',
            IntDocNumber: ttn,
            RecipientPhone: recipientPhone,
            PayerType: possibility.PayerType || 'Recipient',
            PaymentMethod: possibility.PaymentMethod || 'Cash'
        };

        if (possibility.ContactPersonSender) {
            methodProperties.SenderContactName = possibility.ContactPersonSender;
        }
        if (possibility.SenderPhone) {
            methodProperties.SenderPhone = possibility.SenderPhone;
        }
        if (possibility.RecipientCounterparty) {
            methodProperties.Recipient = possibility.RecipientCounterparty;
        }

        const resolvedRecipientName = recipientName || possibility.ContactPersonRecipient;
        if (resolvedRecipientName) {
            methodProperties.RecipientContactName = resolvedRecipientName;
        }

        const result = await this.callApiDetailed<any[]>('AdditionalServiceGeneral', 'save', methodProperties);
        if (result.success) {
            const firstRecord = Array.isArray(result.data) ? result.data[0] : null;
            logger.info({
                ttn,
                method: 'orderChangeEW',
                payerType: methodProperties.PayerType,
                paymentMethod: methodProperties.PaymentMethod,
                hasSenderPhone: Boolean(methodProperties.SenderPhone),
                hasRecipientCounterparty: Boolean(methodProperties.Recipient),
                hasRecipientContactName: Boolean(methodProperties.RecipientContactName),
                orderRef: firstRecord?.Ref ?? null,
                orderNumber: firstRecord?.Number ?? null
            }, 'Nova Poshta change request created');
            return {
                success: true,
                orderRef: firstRecord?.Ref,
                orderNumber: firstRecord?.Number,
                method: 'orderChangeEW'
            };
        }

        const firstError = this.getPrimaryErrorMessage(result);
        logger.warn({
            ttn,
            method: 'orderChangeEW',
            errorMessage: firstError,
            payerType: methodProperties.PayerType,
            paymentMethod: methodProperties.PaymentMethod,
            hasSenderPhone: Boolean(methodProperties.SenderPhone),
            hasRecipientCounterparty: Boolean(methodProperties.Recipient),
            hasRecipientContactName: Boolean(methodProperties.RecipientContactName)
        }, 'Nova Poshta change request failed');
        return {
            success: false,
            errorCode: this.classifyError(firstError),
            errorMessage: firstError,
            method: 'orderChangeEW'
        };
    }

    /**
     * Change recipient on a parcel (Зміна даних отримувача)
     * Uses AdditionalServiceGeneral.save with OrderType=orderChangeEW
     */
    async createTrustee(ttn: string, recipientPhone: string, recipientName?: string): Promise<NPTrusteeCreationResult> {
        const possibilityResult = await this.checkPossibilityChangeEW(ttn);
        if (!possibilityResult.success) {
            const primaryError = this.getPrimaryErrorMessage(possibilityResult);
            const errorCode = this.classifyError(primaryError);
            logger.warn({
                ttn,
                method: 'CheckPossibilityChangeEW',
                errorCode,
                errorMessage: primaryError
            }, 'Nova Poshta change flow stopped during possibility check');
            return {
                success: false,
                errorCode,
                errorMessage: primaryError,
                method: 'checkPossibilityChangeEW'
            };
        }

        const possibility = Array.isArray(possibilityResult.data) ? possibilityResult.data[0] : null;
        if (!possibility) {
            return {
                success: false,
                errorCode: 'API_ERROR',
                errorMessage: 'Nova Poshta returned empty possibility response',
                method: 'checkPossibilityChangeEW'
            };
        }

        if (!possibility.CanChangeRecipient) {
            logger.warn({
                ttn,
                method: 'CheckPossibilityChangeEW',
                canChangeRecipient: possibility.CanChangeRecipient,
                payerType: possibility.PayerType ?? null,
                paymentMethod: possibility.PaymentMethod ?? null,
                currentRecipientPhone: possibility.RecipientPhone ?? null,
                currentRecipientCounterparty: possibility.RecipientCounterparty ?? null
            }, 'Nova Poshta forbids recipient change for shipment');
            return {
                success: false,
                errorCode: 'SHIPMENT_LOCKED',
                errorMessage: 'Nova Poshta does not allow changing the recipient for this shipment',
                method: 'checkPossibilityChangeEW'
            };
        }

        const primaryResult = await this.tryOrderChangeEW(ttn, recipientPhone, recipientName, possibility);
        if (primaryResult.success) {
            return primaryResult;
        }

        logger.warn(
            {
                ttn,
                recipientPhone,
                errorCode: primaryResult.errorCode,
                errorMessage: primaryResult.errorMessage,
                method: primaryResult.method
            },
            'Nova Poshta trustee creation failed'
        );

        return primaryResult;
    }
}

export const novaPoshtaService = new NovaPoshtaService();
