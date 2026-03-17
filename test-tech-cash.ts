import { google } from "googleapis";
import path from "path";

const SPREADSHEET_ID_TECH_CASH = "1MmQrK0QffR3MUoqZz1yDsBFx8o07D9yuOk-wIxCEi5Y";

const dbLocations = [
    { id: "1", name: "Smile Park Київ", city: "Київ", sheet: "SP Київ", fopId: "POSREDNIKOVA" },
    { id: "2", name: "Smile Park Lviv", city: "Lviv", sheet: "Leoland", fopId: "GUPALOVA" }
];

async function run() {
    const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const ranges = dbLocations.map(loc => `${loc.sheet}!A:Z`);
        
        const res = await sheets.spreadsheets.values.batchGet({
            spreadsheetId: SPREADSHEET_ID_TECH_CASH,
            ranges: ranges,
            valueRenderOption: 'FORMATTED_VALUE'
        });
        
        res.data.valueRanges?.forEach((range: any, idx) => {
            const loc = dbLocations[idx];
            const rows = range.values || [];
            
            // Replicate the exact parser logic from tech-cash.ts
            const targetDay = 20, targetMonth = 2, targetYear = 2026;
            const matchingRows = rows.filter((r: any[]) => {
                if (!r[0]) return false;
                const cell = String(r[0]).trim();
                const nums = cell.match(/\d+/g);
                if (!nums || nums.length < 2) return false;
                const a = parseInt(nums[0]), b = parseInt(nums[1]), c = nums[2] ? parseInt(nums[2]) : 0;
                let cd, cm, cy;
                if (a > 31) { cy = a; cm = b; cd = c; }
                else if (b > 12) { cd = a; cm = 0; cy = b; }
                else { cd = a; cm = b; cy = c; }
                if (cy > 0 && cy < 100) cy += 2000;
                if (cm === 0) return cd === targetDay && cy === targetYear;
                return cd === targetDay && cm === targetMonth && (cy === 0 || cy === targetYear);
            });
            
            console.log(`\n--- ${loc.name} (${loc.sheet}) ---`);
            console.log(`Matched rows for ${targetDay}.${targetMonth}.${targetYear}:`, matchingRows.length);
            if (matchingRows.length > 0) {
                const todayRow = matchingRows[matchingRows.length - 1];
                console.log(`Cash: ${todayRow[3]} | Term: ${todayRow[4]} | Salary: ${todayRow[7]}`);
            }
        });
        
    } catch(e) { console.error("error:", e); }
}
run();
