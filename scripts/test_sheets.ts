import { google } from "googleapis";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config();

const SPREADSHEET_ID_TEAM = process.env.SPREADSHEET_ID_TEAM;
const SPREADSHEET_ID_SCHEDULE = process.env.SPREADSHEET_ID_SCHEDULE;

async function testSheets() {
    console.log("🔍 Starting Google Sheets Diagnostic...");

    let auth;
    if (process.env.GOOGLE_REFRESH_TOKEN) {
        console.log("🎫 Using OAuth2 Refresh Token");
        auth = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        auth.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
            scope: 'https://www.googleapis.com/auth/spreadsheets'
        });
    } else {
        console.log("🔑 Using Service Account");
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        auth = new google.auth.GoogleAuth({
            keyFile: KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    const sheets = google.sheets({ version: 'v4', auth });

    async function checkSpreadsheet(id: string | undefined, label: string) {
        if (!id) {
            console.error(`❌ ${label} ID is missing in .env`);
            return;
        }
        console.log(`\n--- Testing ${label} (ID: ${id}) ---`);
        try {
            const res = await sheets.spreadsheets.get({ spreadsheetId: id });
            console.log(`✅ ${label} found: "${res.data.properties?.title}"`);
            console.log("Available sheets:");
            res.data.sheets?.forEach(s => {
                console.log(`  - "${s.properties?.title}"`);
            });
        } catch (e: any) {
            console.error(`❌ ${label} lookup failed: ${e.message}`);
            if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
        }
    }

    await checkSpreadsheet(SPREADSHEET_ID_TEAM, "Team Spreadsheet");
    await checkSpreadsheet(SPREADSHEET_ID_SCHEDULE, "Schedule Spreadsheet");
}

testSheets().catch(console.error);
