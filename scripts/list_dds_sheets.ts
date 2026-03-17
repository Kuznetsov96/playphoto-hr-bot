import { google } from 'googleapis';
import path from 'path';
import { SPREADSHEET_ID_DDS } from '../src/config.js';

async function main() {
    console.log("📑 Listing sheets for DDS Spreadsheet...");

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

    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID_DDS,
        });

        const sheetNames = response.data.sheets?.map(s => s.properties?.title);
        console.log("✅ Sheet Names:", sheetNames);
    } catch (error) {
        console.error("❌ Error listing sheets:", error);
    }
}

main().catch(console.error);
