import fetch from 'node-fetch';
import { NOVA_POSHTA_API_KEY, NP_RECIPIENT_PHONE } from '../config.js';
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

export class NovaPoshtaService {
    private readonly apiUrl = 'https://api.novaposhta.ua/v2.0/json/';

    /**
     * Common method to call NP API
     */
    async callApi(modelName: string, calledMethod: string, methodProperties: any = {}) {
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
                logger.error({ errors: data.errors, warnings: data.warnings, modelName, calledMethod }, 'Nova Poshta API Error');
                return null;
            }

            if (data.warnings && data.warnings.length > 0) {
                logger.warn({ warnings: data.warnings, modelName, calledMethod }, 'Nova Poshta API Warning');
            }

            return data.data;
        } catch (error) {
            logger.error({ error, modelName, calledMethod }, 'Nova Poshta API Network Error');
            return null;
        }
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
    async createTrustee(ttn: string, recipientPhone: string, recipientName?: string): Promise<boolean> {
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

        const primaryResult = await this.callApi('AdditionalServiceGeneral', 'save', methodProperties);
        if (primaryResult) {
            return true;
        }

        const customerPhone = NP_RECIPIENT_PHONE?.replace(/\D/g, '') || '';
        if (customerPhone) {
            const fallbackResult = await this.callApi('AdditionalService', 'save', {
                OrderType: 'orderTrustee',
                IntDocNumber: ttn,
                CustomerPhone: customerPhone,
                TrusteePhone: recipientPhone
            });

            if (fallbackResult) {
                logger.info({ ttn, recipientPhone }, '📦 NP trustee created via orderTrustee fallback');
                return true;
            }
        }

        logger.warn(
            {
                ttn,
                recipientPhone,
                recipientName,
                fallbackTried: Boolean(customerPhone)
            },
            '📦 NP trustee creation failed. Check API privileges or try through the NP mobile app.'
        );
        return false;
    }
}

export const novaPoshtaService = new NovaPoshtaService();
