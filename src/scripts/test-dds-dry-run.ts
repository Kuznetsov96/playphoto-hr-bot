import { syncToDDS } from "../services/finance-report.js";

async function main() {
    const todayStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    console.log(`🚀 Dry run for ${todayStr}...`);
    const result = await syncToDDS(todayStr, undefined, true);
    console.log(result.message);
}

main().catch(console.error);
