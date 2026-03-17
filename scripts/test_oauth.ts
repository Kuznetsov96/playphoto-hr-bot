import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();

async function testOAuth() {
    console.log("🔐 Testing OAuth2 Refresh Token...\n");

    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        scope: 'https://www.googleapis.com/auth/spreadsheets'
    });

    try {
        // Test 1: Get access token
        console.log("📝 Step 1: Refreshing access token...");
        const tokenResponse = await auth.getAccessToken();
        console.log("✅ Access token obtained successfully");
        console.log(`Token expires at: ${new Date(tokenResponse.res?.data.expiry_date || 0).toISOString()}\n`);

        // Test 2: Get user info
        console.log("👤 Step 2: Getting user info...");
        const oauth2 = google.oauth2({ version: 'v2', auth });
        const userInfo = await oauth2.userinfo.get();
        console.log(`✅ Authenticated as: ${userInfo.data.email}`);
        console.log(`Name: ${userInfo.data.name}\n`);

        // Test 3: List accessible spreadsheets
        console.log("📊 Step 3: Testing spreadsheet access...");
        const sheets = google.sheets({ version: 'v4', auth });

        const SPREADSHEET_ID_TEAM = process.env.SPREADSHEET_ID_TEAM;
        const SPREADSHEET_ID_SCHEDULE = process.env.SPREADSHEET_ID_SCHEDULE;

        async function testSpreadsheet(id: string | undefined, label: string) {
            if (!id) {
                console.error(`❌ ${label} ID is missing in .env`);
                return;
            }
            try {
                const res = await sheets.spreadsheets.get({ spreadsheetId: id });
                console.log(`✅ ${label}: "${res.data.properties?.title}"`);
                console.log(`   Owner: ${res.data.properties?.locale || 'Unknown'}`);
                console.log(`   Sheets: ${res.data.sheets?.map(s => s.properties?.title).join(', ')}`);
            } catch (e: any) {
                console.error(`❌ ${label} access failed: ${e.message}`);
                if (e.code === 404) {
                    console.error(`   → Spreadsheet not found or no access`);
                } else if (e.code === 403) {
                    console.error(`   → Permission denied`);
                }
            }
        }

        await testSpreadsheet(SPREADSHEET_ID_TEAM, "Team Spreadsheet");
        await testSpreadsheet(SPREADSHEET_ID_SCHEDULE, "Schedule Spreadsheet");

    } catch (e: any) {
        console.error("\n❌ OAuth2 test failed:");
        console.error(e.message);
        if (e.response?.data) {
            console.error(JSON.stringify(e.response.data, null, 2));
        }
    }
}

testOAuth().catch(console.error);
