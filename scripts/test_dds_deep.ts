import * as dotenv from "dotenv";
dotenv.config();
import { google } from 'googleapis';
import path from 'path';

async function main() {
    const spreadsheetId = "1DqqK04-pqEY_L0g3Tu8EQl1lTDUoea5xpg2_7kPXZPA";
    console.log(`🧪 Starting Deep DDS Test for ID: ${spreadsheetId}`);

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
        const ss = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetNames = ss.data.sheets?.map(s => s.properties?.title) || [];
        console.log("✅ Found Sheets:", sheetNames);

        for (const name of sheetNames) {
            console.log(`\n🔍 Trying to read A1 from [${name}]...`);
            try {
                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId,
                    range: `'${name}'!A1:C10`,
                });
                console.log(`✅ Success reading [${name}]. First row:`, JSON.stringify(res.data.values?.[0]));
            } catch (e: any) {
                console.error(`❌ Failed to read [${name}]: ${e.message}`);
            }
        }
    } catch (error: any) {
        console.error("❌ Fatal Error:", error.message);
    }
}

main().catch(console.error);
