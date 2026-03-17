import * as dotenv from "dotenv";
dotenv.config();
import { ddsService } from '../src/services/finance/dds.js';
import { DDS_BALANCE_CELLS } from '../src/config.js';

async function main() {
    console.log("🧪 Starting DDS Balance Test...");
    const CORRECT_ID = "1DqqK04-pqEY_L0g3Tu8EQl1lTDUoea5xpg2_7kPXZPA";
    const spreadsheetId = process.env.SPREADSHEET_ID_DDS || CORRECT_ID;

    console.log(`📡 Using Spreadsheet ID: ${spreadsheetId} (Length: ${spreadsheetId.length})`);

    for (const [fop, cell] of Object.entries(DDS_BALANCE_CELLS)) {
        console.log(`🔍 Reading ${fop} from ${cell}...`);
        try {
            // @ts-ignore
            const response = await ddsService.sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: cell,
            });
            console.log(`📡 Raw Response for ${fop}:`, JSON.stringify(response.data.values));

            const balance = await ddsService.getCellBalance(cell);
            console.log(`✅ ${fop} Final Balance: ${balance} UAH`);
        } catch (error: any) {
            console.error(`❌ Error reading ${fop}:`, error.message);
        }
    }
}

main().catch(console.error);
