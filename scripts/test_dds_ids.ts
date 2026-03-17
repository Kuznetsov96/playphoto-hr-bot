import { google } from 'googleapis';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const IDS = [
    "1DqqK04-pqEY_L0g3Tu8EQl1lTDUoea5xpg2_7kPXZPA", // Correct 44 chars
];

async function main() {
    let auth;
    if (process.env.GOOGLE_REFRESH_TOKEN) {
        auth = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        auth.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
            scope: 'https://www.googleapis.com/auth/spreadsheets'
        });
    } else {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        auth = new google.auth.GoogleAuth({
            keyFile: KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    const sheets = google.sheets({ version: 'v4', auth });

    const cells = {
        KUZNETSOV: "'ДДС месяц'!C3",
        POSREDNIKOVA: "'ДДС месяц'!E3",
        KARPUK: "'ДДС месяц'!G1",
        GUPALOVA: "'ДДС месяц'!C2"
    };

    for (const id of IDS) {
        console.log(`\n🧐 Testing Spreadsheet ID: ${id}`);
        try {
            for (const [name, range] of Object.entries(cells)) {
                console.log(`🔍 Reading ${name} (${range})...`);
                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: id,
                    range: range,
                });
                console.log(`✅ ${name} Value:`, JSON.stringify(res.data.values));
            }
        } catch (error: any) {
            console.error(`❌ FAILED: ${error.message} (Code: ${error.code})`);
        }
    }
}

main().catch(console.error);
