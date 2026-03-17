import * as dotenv from 'dotenv';
dotenv.config();
import fetch from 'node-fetch';
import { NOVA_POSHTA_API_KEY } from './src/config.js';

async function testFullListNoFilter() {
    console.log('Testing InternetDocument.getDocumentList without any Ref filter...');
    const now = new Date();
    const dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.'); 
    const dateTo = now.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');

    const body = {
        apiKey: NOVA_POSHTA_API_KEY,
        modelName: 'InternetDocument',
        calledMethod: 'getDocumentList',
        methodProperties: {
            DateTimeFrom: dateFrom,
            DateTimeTo: dateTo,
            GetFullList: "1"
        }
    };

    try {
        const response = await fetch('https://api.novaposhta.ua/v2.0/json/', {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' }
        });

        const data: any = await response.json();
        console.log(`✅ Success! Found ${data.data?.length || 0} documents in total.`);
        if (data.data?.length > 0) {
            console.log('Sample (first 3):');
            data.data.slice(0, 3).forEach((d: any) => {
                console.log(`- TTN: ${d.Number}, Recipient: ${d.RecipientContact}, Sender: ${d.SenderContact}`);
            });
        }
    } catch (error) {
        console.error('Network error:', error);
    }
}

testFullListNoFilter();
