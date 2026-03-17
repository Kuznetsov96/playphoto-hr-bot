import { google } from "googleapis";
import path from "path";

async function testServiceAccount() {
    console.log("🔐 Testing Service Account access...\n");

    const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
    console.log(`📄 Using service account from: ${KEY_PATH}\n`);

    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Read from local file to avoid env dependency
    const fs = await import('fs/promises');
    const serviceAccount = JSON.parse(await fs.readFile(KEY_PATH, 'utf-8'));
    console.log(`👤 Service Account: ${serviceAccount.client_email}\n`);

    const SPREADSHEET_ID_TEAM = "1czRfbCuis-3EAkia8QrcmLHNMmYp-I8b9yWAiENKQQc";
    const SPREADSHEET_ID_SCHEDULE = "1bc6EnZ2YdXuzSl_ik_XEAS06ZaDsKWMwGMqqD1YlOHg";

    async function testSpreadsheet(id: string, label: string) {
        console.log(`📊 Testing ${label}...`);
        try {
            const res = await sheets.spreadsheets.get({ spreadsheetId: id });
            console.log(`✅ SUCCESS: "${res.data.properties?.title}"`);
            console.log(`   Available sheets:`);
            res.data.sheets?.forEach(s => {
                console.log(`     - "${s.properties?.title}"`);
            });
            console.log();
        } catch (e: any) {
            console.error(`❌ FAILED: ${e.message}`);
            console.error(`   Status: ${e.code}`);
            if (e.code === 404) {
                console.error(`   → Spreadsheet not found OR service account has no access`);
                console.error(`   → Make sure ${serviceAccount.client_email} is added to the spreadsheet`);
            } else if (e.code === 403) {
                console.error(`   → Permission denied - add service account with Editor role`);
            }
            console.log();
        }
    }

    await testSpreadsheet(SPREADSHEET_ID_TEAM, "Team Spreadsheet");
    await testSpreadsheet(SPREADSHEET_ID_SCHEDULE, "Schedule Spreadsheet");
}

testServiceAccount().catch(console.error);
