import { google } from "googleapis";
import { SPREADSHEET_ID_TEAM } from "../config.js";
import fs from "fs";

async function checkSpreadsheet() {
    const auth = new google.auth.GoogleAuth({
        keyFile: "google-service-account.json",
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    console.log(`📊 Fetching sheet data for ${SPREADSHEET_ID_TEAM}...`);
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID_TEAM,
        range: "'В роботі'!A1:S500",
    });

    const rows = res.data.values;
    if (!rows) {
        console.log("❌ No data found.");
        return;
    }

    console.log(`🔍 Searching for 'Мостова' in ${rows.length} rows...`);
    for (let i = 0; i < rows.length; i++) {
        const rowString = JSON.stringify(rows[i]);
        if (rowString.includes("Мостова")) {
            console.log(`✅ Found at row ${i + 1}:`);
            console.log(JSON.stringify(rows[i], null, 2));

            // Log specifically column R (index 17) - TG ID
            const row = rows[i];
            const tgIdVal = row ? row[17] : undefined;
            console.log(`Telegram ID (Col R): [${tgIdVal}] type: ${typeof tgIdVal}`);
        }
    }
}

checkSpreadsheet().catch(console.error);
