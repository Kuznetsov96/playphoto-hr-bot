import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();

async function testDirectAccess() {
    console.log("🔐 Testing direct spreadsheet access...\n");

    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        scope: 'https://www.googleapis.com/auth/spreadsheets'
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const SPREADSHEET_ID_TEAM = process.env.SPREADSHEET_ID_TEAM;
    const SPREADSHEET_ID_SCHEDULE = process.env.SPREADSHEET_ID_SCHEDULE;

    async function testSpreadsheet(id: string | undefined, label: string) {
        if (!id) {
            console.error(`❌ ${label} ID is missing in .env`);
            return;
        }
        console.log(`\n📊 Testing ${label} (ID: ${id})...`);
        try {
            const res = await sheets.spreadsheets.get({ spreadsheetId: id });
            console.log(`✅ SUCCESS: "${res.data.properties?.title}"`);
            console.log(`   Available sheets:`);
            res.data.sheets?.forEach(s => {
                console.log(`     - "${s.properties?.title}"`);
            });
        } catch (e: any) {
            console.error(`❌ FAILED: ${e.message}`);
            console.error(`   Status: ${e.code}`);
            if (e.code === 404) {
                console.error(`   → Spreadsheet ID is invalid OR account has no access`);
                console.error(`   → Check if this Google account owns/has access to this spreadsheet`);
            } else if (e.code === 403) {
                console.error(`   → Permission denied - account needs to be granted access`);
            } else if (e.code === 401) {
                console.error(`   → Authentication failed - token may be expired or invalid`);
            }
        }
    }

    await testSpreadsheet(SPREADSHEET_ID_TEAM, "Team Spreadsheet");
    await testSpreadsheet(SPREADSHEET_ID_SCHEDULE, "Schedule Spreadsheet");
}

testDirectAccess().catch(console.error);
