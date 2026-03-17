import { google } from "googleapis";
import path from "path";

const SPREADSHEET_ID_TECH_CASH = "1MmQrK0QffR3MUoqZz1yDsBFx8o07D9yuOk-wIxCEi5Y";

const dbLocations = [
    { id: "1", name: "Smile Park Київ", city: "Київ", sheet: "SP Київ", fopId: "POSREDNIKOVA", hasAcquiring: true, cashInEnvelope: false },
    { id: "2", name: "Smile Park Lviv", city: "Львів", sheet: "Leoland", fopId: "GUPALOVA", hasAcquiring: true, cashInEnvelope: false }
];

async function getIncome(dateStr: string) {
    const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const ranges = dbLocations.map(loc => `${loc.sheet}!A:Z`);
    const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID_TECH_CASH,
        ranges,
        valueRenderOption: 'FORMATTED_VALUE'
    });

    const parts = dateStr.split('.');
    const td = parseInt(parts[0]), tm = parseInt(parts[1]), ty = parseInt(parts[2]);

    const incomes: any[] = [];
    res.data.valueRanges?.forEach((range, idx) => {
        const loc = dbLocations[idx];
        const rows = range.values || [];
        const matchingRows = rows.filter((r: any[]) => {
            if (!r[0]) return false;
            const nums = String(r[0]).match(/\d+/g);
            if (!nums || nums.length < 2) return false;
            const a = parseInt(nums[0]), b = parseInt(nums[1]), c = nums[2] ? parseInt(nums[2]) : 0;
            let cd, cm, cy;
            if (a > 31) { cy = a; cm = b; cd = c; }
            else if (b > 12) { cd = a; cm = 0; cy = b; }
            else { cd = a; cm = b; cy = c; }
            if (cy > 0 && cy < 100) cy += 2000;
            if (cm === 0) return cd === td && cy === ty;
            return cd === td && cm === tm && (cy === 0 || cy === ty);
        });
        if (matchingRows.length > 0) {
            const row = matchingRows[matchingRows.length - 1];
            const norm = (v: any) => parseFloat(String(v || "0").replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '')) || 0;
            incomes.push({
                locationName: loc.name,
                city: loc.city,
                totalCash: norm(row[3]),
                totalTerminal: norm(row[4]),
                totalSalary: norm(row[7])
            });
        }
    });
    return incomes;
}

const DDS_ARTICLE_MAPPING: Record<string, string> = {
    "Smile Park Lviv": "Выручка от продаж Leolend",
};

async function syncDryRun(dateStr: string) {
    console.log(`\n--- SYNC FOR ${dateStr} ---`);
    const incomes = await getIncome(dateStr);

    for (const inc of incomes) {
        const loc = dbLocations.find(l => l.name === inc.locationName);
        const fopTerminalName = loc?.fopId;
        const fopCashId = "KUZNETSOV";

        const salary = inc.totalSalary || 0;
        const netCash = Math.max(0, inc.totalCash - salary);

        const fullName = inc.locationName.includes(inc.city) ? inc.locationName : `${inc.locationName} ${inc.city}`;
        const articleName = DDS_ARTICLE_MAPPING[inc.locationName] || (inc.locationName === "Smile Park Київ" ? "Выручка от продаж Smile Park Київ" : `Выручка от продаж ${fullName}`);

        if (netCash >= 0 && (netCash > 0 || salary > 0)) {
            const locationLabel = `${fullName} (Готівка)`;
            console.log(`[DRY] Add Cash: ${netCash} | FOP: ${fopCashId} | ${locationLabel} | Cat: ${articleName}`);
        } else {
            console.log(`[SKIP] Cash for ${fullName}: Cash (${inc.totalCash}) <= Salary (${salary})`);
        }

        if (inc.totalTerminal > 0) {
            const feeRate = loc?.hasAcquiring ? 0.013 : 0;
            const netTerminal = Number((inc.totalTerminal * (1 - feeRate)).toFixed(2));
            if (netTerminal > 0) {
                const locationLabel = `${fullName} (Термінал)`;
                console.log(`[DRY] Add Terminal: ${netTerminal} (Origin: ${inc.totalTerminal}) | FOP: ${fopTerminalName} | ${locationLabel} | Cat: ${articleName}`);
            }
        } else {
            console.log(`[SKIP] Terminal for ${fullName} = 0`);
        }
    }
}

async function run() {
    await syncDryRun("20.02.2026");
}
run();
