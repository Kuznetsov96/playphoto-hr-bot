import { google } from "googleapis";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const SPREADSHEET_ID = "1czRfbCuis-3EAkia8QrcmLHNMmYp-I8b9yWAiENKQQc";
const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');

async function checkSheets() {
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
        });
        console.log("✅ Successfully connected to spreadsheet!");
        console.log("Sheets found:");
        response.data.sheets?.forEach(s => {
            console.log(`- "${s.properties?.title}" (ID: ${s.properties?.sheetId})`);
        });
    } catch (e: any) {
        console.error("❌ Failed to access spreadsheet:");
        console.error(e.message);
    }
}

checkSheets();
