import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();

async function listAccessibleSheets() {
    console.log("📊 Listing all accessible Google Sheets...\n");

    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets'
    });

    try {
        const drive = google.drive({ version: 'v3', auth });

        console.log("🔍 Searching for spreadsheets...\n");

        const res = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.spreadsheet'",
            fields: 'files(id, name, owners, createdTime, modifiedTime)',
            pageSize: 50,
            orderBy: 'modifiedTime desc'
        });

        const files = res.data.files || [];

        if (files.length === 0) {
            console.log("❌ No spreadsheets found that this account can access.");
            console.log("\n💡 This means:");
            console.log("   1. The OAuth account has no spreadsheets");
            console.log("   2. OR the token doesn't have drive.readonly scope");
            return;
        }

        console.log(`✅ Found ${files.length} accessible spreadsheets:\n`);

        files.forEach((file, index) => {
            console.log(`${index + 1}. "${file.name}"`);
            console.log(`   ID: ${file.id}`);
            console.log(`   Owner: ${file.owners?.map(o => o.emailAddress).join(', ') || 'Unknown'}`);
            console.log(`   Modified: ${new Date(file.modifiedTime || '').toLocaleString()}`);
            console.log();
        });

        console.log("\n📋 To fix the sync issue:");
        console.log("1. Find the correct spreadsheet IDs from the list above");
        console.log("2. Update .env file with:");
        console.log("   SPREADSHEET_ID_TEAM=<correct_team_id>");
        console.log("   SPREADSHEET_ID_SCHEDULE=<correct_schedule_id>");
        console.log("\nOR");
        console.log("1. Share the spreadsheets with this Google account");
        console.log("2. Keep the current IDs in .env");

    } catch (e: any) {
        console.error("\n❌ Failed to list spreadsheets:");
        console.error(e.message);
        if (e.code === 403) {
            console.error("\n💡 The OAuth token doesn't have drive.readonly scope.");
            console.error("   You need to re-authorize with additional scopes.");
        }
    }
}

listAccessibleSheets().catch(console.error);
