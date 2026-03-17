import { scheduleSyncService } from "../services/schedule-sync.js";
import { google } from "googleapis";
import { SPREADSHEET_ID_TEAM } from "../config.js";

async function listSheets() {
    const service: any = scheduleSyncService;
    const auth = service.auth;
    const sheets = google.sheets({ version: 'v4', auth });

    console.log(`🔍 Listing sheets for Spreadsheet ID: ${SPREADSHEET_ID_TEAM}`);
    const res = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID_TEAM
    });

    const spreadsheet = res.data;
    console.log(`📊 Spreadsheet Title: ${spreadsheet.properties?.title}`);
    console.log("📄 Sheets:");
    spreadsheet.sheets?.forEach(s => {
        console.log(`- ${s.properties?.title} (ID: ${s.properties?.sheetId})`);
    });
}

async function checkStaffRows() {
    const service: any = scheduleSyncService;
    const auth = service.auth;
    const sheets = google.sheets({ version: 'v4', auth });

    const sheetNames = ["В роботі", "Нові"];

    for (const sheetName of sheetNames) {
        console.log(`🔍 Fetching first 1000 rows from '${sheetName}'...`);
        try {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: `'${sheetName}'!A1:S1000`
            });

            const rows = res.data.values;
            if (!rows) {
                console.log(`❌ No rows found in '${sheetName}'`);
                continue;
            }

            console.log(`📊 Total rows fetched from '${sheetName}': ${rows.length}`);

            const targets = ["Ольхович", "Мостова", "Mostova"];

            rows.forEach((row, i) => {
                const fullName = String(row[2] || "");
                const locName = String(row[14] || "");
                const tgId = String(row[17] || "");
                const status = String(row[5] || "");

                if (targets.some(t => fullName.includes(t))) {
                    console.log(`[${sheetName}] Row ${i + 1}: [${fullName}] | Loc: [${locName}] | TG: [${tgId}] | Status: [${status}]`);
                }
            });

            // Also check how many have TG IDs
            const withIds = rows.filter(r => String(r[17] || "").length > 5).length;
            console.log(`✅ [${sheetName}] Rows with Telegram IDs: ${withIds}`);
        } catch (e: any) {
            console.error(`❌ Error fetching sheet '${sheetName}': ${e.message}`);
        }
    }
}

async function main() {
    await listSheets();
    await checkStaffRows();
}

main().catch(console.error);
