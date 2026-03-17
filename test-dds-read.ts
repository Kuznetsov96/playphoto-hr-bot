import { google } from "googleapis";
import path from "path";

const SPREADSHEET_ID_DDS = "1DqqK04-pqEY_L0g3Tu8EQl1lTDUoea5xpg2_7kPXZPA";

async function run() {
    const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID_DDS,
            range: 'A:I',
        });

        const rows = res.data.values || [];
        // Look for recent dates in 20.02 or 21.02
        const recent = rows.filter((r: any[]) => r[2] === "20.02.2026" || r[2] === "21.02.2026");

        if (recent.length === 0) {
            console.log("No transactions found for 20.02 or 21.02!");
        } else {
            console.log("Recent Transactions:");
            recent.forEach(r => {
                console.log(`[${r[2]}] FOP: ${r[4]} | Loc: ${r[6]} | Amt: ${r[3]} | Cat: ${r[8]} | Comment: ${r[7]}`);
            });
        }

    } catch (e) { console.error("error:", e); }
}
run();
