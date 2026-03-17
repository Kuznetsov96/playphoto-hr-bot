import { google } from "googleapis";
import path from "path";
import { SPREADSHEET_ID_TECH_CASH } from "../config.js";

async function main() {
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
        auth = new google.auth.GoogleAuth({
            keyFile: path.join(process.cwd(), 'google-service-account.json'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    const sheets = google.sheets({ version: 'v4', auth });
    console.log(`Spreadsheet ID: ${SPREADSHEET_ID_TECH_CASH}\n`);

    const res = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID_TECH_CASH,
        fields: 'sheets.properties.title,sheets.properties.sheetId'
    });

    const sheetList = res.data.sheets || [];
    console.log(`Found ${sheetList.length} sheets:\n`);
    sheetList.forEach((s, i) => {
        console.log(`   ${i + 1}. "${s.properties?.title}" (id: ${s.properties?.sheetId})`);
    });
}

main().catch(e => { console.error(e); process.exit(1); });
