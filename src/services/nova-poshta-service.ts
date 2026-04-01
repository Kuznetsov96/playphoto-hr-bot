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

export type NPTrusteeErrorCode = 'SHIPMENT_LOCKED' | 'API_ERROR';

export interface NPTrusteeCreationResult {
    success: boolean;
    errorCode?: NPTrusteeErrorCode;
    errorMessage?: string;
    orderRef?: string;
    orderNumber?: string;
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

    /**
     * Change recipient on a parcel (Зміна даних отримувача)
     * Uses AdditionalServiceGeneral.save with OrderType=orderChangeEW
     */
    async createTrustee(ttn: string, recipientPhone: string, recipientName?: string): Promise<NPTrusteeCreationResult> {
        const methodProperties: Record<string, string> = {
            OrderType: 'orderChangeEW',
            IntDocNumber: ttn,
            RecipientPhone: recipientPhone,
            PayerType: 'Recipient',
            PaymentMethod: 'Cash'
        };

        if (recipientName) {
            methodProperties.RecipientContactName = recipientName;
        }

        const primaryResult = await this.callApiDetailed('AdditionalServiceGeneral', 'save', methodProperties);
        if (primaryResult.success) {
            const firstRecord = Array.isArray(primaryResult.data) ? primaryResult.data[0] : null;
            return {
                success: true,
                orderRef: firstRecord?.Ref,
                orderNumber: firstRecord?.Number
            };
        }

        const firstError = primaryResult.errors[0] || primaryResult.info[0] || primaryResult.warnings[0] || 'Unknown API error';
        const loweredError = firstError.toLowerCase();

        const errorCode: NPTrusteeErrorCode = (
            loweredError.includes('further data changes are not possible') ||
            loweredError.includes('delivered to the recipient')
        )
            ? 'SHIPMENT_LOCKED'
            : 'API_ERROR';

        logger.warn(
            {
                ttn,
                recipientPhone,
                errorCode,
                errorMessage: firstError
            },
            'Nova Poshta trustee creation failed'
        );

        return {
            success: false,
            errorCode,
            errorMessage: firstError
        };
    }
}

export const novaPoshtaService = new NovaPoshtaService();
