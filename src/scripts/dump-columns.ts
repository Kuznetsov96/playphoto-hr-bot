import { scheduleSyncService } from "../services/schedule-sync.js";
import { google } from "googleapis";
import { SPREADSHEET_ID_TEAM } from "../config.js";

async function dumpAllColumns() {
    const service: any = scheduleSyncService;
    const auth = service.auth;
    const sheets = google.sheets({ version: 'v4', auth });

    console.log("🔍 Fetching first 100 rows from 'В роботі' to inspect columns...");
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID_TEAM,
        range: "'В роботі'!A1:Z100" // Fetch up to Z to see everything
    });

    const rows = res.data.values;
    if (!rows) return console.log("❌ No rows found");

    const targets = ["Ольхович", "Мостова", "Mostova"];

    rows.forEach((row, i) => {
        const fullName = String(row[2] || "");
        if (targets.some(t => fullName.includes(t)) || i === 0) {
            console.log(`--- ROW ${i + 1} ---`);
            row.forEach((col, j) => {
                console.log(`Col ${String.fromCharCode(65 + j)} (${j}): [${col}]`);
            });
        }
    });
}

dumpAllColumns().catch(console.error);
