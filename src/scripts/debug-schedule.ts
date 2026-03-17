
import { google } from "googleapis";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();

const SPREADSHEET_ID = "1bc6EnZ2YdXuzSl_ik_XEAS06ZaDsKWMwGMqqD1YlOHg";

async function debugSchedule() {
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
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        auth = new google.auth.GoogleAuth({
            keyFile: KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }

    const sheets = google.sheets({ version: 'v4', auth });

    try {
        console.log(`🔍 Reading schedule sheet...`);
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: "'Актуальний розклад'!A1:AL500"
        });

        const rows = res.data.values;
        if (!rows) {
            console.log("No data!");
            return;
        }

        // 1. Show header (dates)
        console.log("\n=== ROW 1 (DATES) ===");
        const header = rows[0];
        header.forEach((cell: any, idx: number) => {
            if (String(cell).trim()) console.log(`  Col ${idx}: "${cell}"`);
        });

        // 2. Collect all unique cell values (shift codes)
        const cellValues = new Map<string, number>();
        const locationRows: { row: number; label: string; cellCount: number }[] = [];

        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0) continue;
            const label = String(row[0] || "").trim();
            if (!label) continue;

            // Count non-empty cells after col 0
            const filledCells = row.slice(1).filter((c: any) => String(c || "").trim()).length;

            // Check if this might be a location header (few or no data cells)
            if (filledCells <= 1) {
                locationRows.push({ row: i + 1, label, cellCount: filledCells });
            }

            // Collect cell values
            for (let j = 1; j < row.length; j++) {
                const val = String(row[j] || "").trim().toUpperCase();
                if (val) {
                    cellValues.set(val, (cellValues.get(val) || 0) + 1);
                }
            }
        }

        // 3. Show potential location sections
        console.log("\n=== POTENTIAL LOCATION HEADERS ===");
        locationRows.forEach(lr => {
            console.log(`  Row ${lr.row}: "${lr.label}" (${lr.cellCount} data cells)`);
        });

        // 4. Show all unique cell values sorted by frequency
        console.log("\n=== ALL UNIQUE CELL VALUES (shift codes) ===");
        const sorted = [...cellValues.entries()].sort((a, b) => b[1] - a[1]);
        sorted.forEach(([val, count]) => {
            console.log(`  "${val}" → ${count} occurrences`);
        });

        // 5. Show first 5 staff rows with their data
        console.log("\n=== SAMPLE STAFF ROWS (first 10 with data) ===");
        let shown = 0;
        for (let i = 2; i < rows.length && shown < 10; i++) {
            const row = rows[i];
            if (!row || row.length === 0) continue;
            const label = String(row[0] || "").trim();
            if (!label) continue;
            const filledCells = row.slice(1).filter((c: any) => String(c || "").trim()).length;
            if (filledCells > 3) { // Likely a staff row
                const cells = row.slice(1, 20).map((c: any, idx: number) => `[${idx + 1}]${String(c || "").trim()}`).join(" ");
                console.log(`  Row ${i + 1}: "${label}" → ${cells}`);
                shown++;
            }
        }

        console.log(`\n📊 Total rows: ${rows.length}, Date columns: ${header.filter((c: any) => String(c).trim()).length - 1}`);

    } catch (e: any) {
        console.error("❌ Error:", e.message);
    }
}

debugSchedule();
