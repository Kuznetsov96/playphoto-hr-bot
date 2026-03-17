
import { google } from "googleapis";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const SPREADSHEET_ID = "1MmQrK0QffR3MUoqZz1yDsBFx8o07D9yuOk-wIxCEi5Y";

async function debugLeoland() {
    let auth: any;
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
        console.log(`🔍 Reading 'Leoland' rows...`);
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'Leoland'!A1:ZZ10"
        });

        const rows = res.data.values;
        if (rows) {
            rows.forEach((row, i) => {
                console.log(`Row ${i + 1}:`, row.map((cell, idx) => `[${idx}] ${cell}`).join(" | "));
            });
        }
    } catch (e: any) {
        console.error("❌ Error reading Leoland:", e.message);
    }
}

debugLeoland();
