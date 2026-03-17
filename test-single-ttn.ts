import * as dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import { NOVA_POSHTA_API_KEY } from './src/config.js';

async function testSingleTTN(ttn: string) {
    console.log(`Testing Single TTN Tracking: ${ttn}`);
    const body = {
        apiKey: NOVA_POSHTA_API_KEY,
        modelName: 'TrackingDocument',
        calledMethod: 'getStatusDocuments',
        methodProperties: {
            Documents: [
                {
                    DocumentNumber: ttn,
                    Phone: ""
                }
            ]
        }
    };

    try {
        const response = await fetch('https://api.novaposhta.ua/v2.0/json/', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' }
        });

        const data: any = await response.json();
        console.log('Response:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Network error:', error);
    }
}

testSingleTTN("20451390341837");
