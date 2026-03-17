import { google } from 'googleapis';
import path from 'path';

const IDS = [
    "1DqqK04-pqEY_L0g3Tu8EQ1lTDUoea5xpg2_7kPXZPA",
    "1DqqK04-pqEY_L0g3Tu8EQl1lTDUoea5xpg2_7kPXZPA",
];

async function main() {
    let auth;
    if (process.env.GOOGLE_REFRESH_TOKEN) {
        auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
        auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN, scope: 'https://www.googleapis.com/auth/spreadsheets' });
    } else {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        auth = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    }
    const sheets = google.sheets({ version: 'v4', auth });

    for (const id of IDS) {
        console.log(`\n🧐 ID: ${id} (Length: ${id.length})`);
        console.log(`📡 Chars: ${id.split('').map(c => `${c}:${c.charCodeAt(0)}`).join(' ')}`);
        try {
            await sheets.spreadsheets.get({ spreadsheetId: id });
            console.log(`✅ SUCCESS!`);
        } catch (error: any) {
            console.error(`❌ FAILED: ${error.message}`);
        }
    }
}
main().catch(console.error);
