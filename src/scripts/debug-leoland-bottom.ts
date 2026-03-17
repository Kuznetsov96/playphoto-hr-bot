
import { google } from "googleapis";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const SPREADSHEET_ID = "1MmQrK0QffR3MUoqZz1yDsBFx8o07D9yuOk-wIxCEi5Y";

async function debugLeolandBottom() {
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
        console.log(`🔍 Reading 'Leoland' last 50 rows...`);
        // We'll read a large range and filter for non-empty rows at the end if possible,
        // or just read something like A500:F1000
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'Leoland'!A:E"
        });

        const rows = res.data.values;
        if (rows) {
            const lastRows = rows.slice(-30);
            lastRows.forEach((row, i) => {
                console.log(`Row [${rows.length - 30 + i + 1}]:`, row.join(" | "));
            });
        }
    } catch (e: any) {
        console.error("❌ Error reading Leoland:", e.message);
    }
}

debugLeolandBottom();
