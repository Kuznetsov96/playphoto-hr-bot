import { techCashService } from "../src/services/finance/tech-cash.js";
import { locationRepository } from "../src/repositories/location-repository.js";
import logger from "../src/core/logger.js";

async function debug() {
    const todayStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
    console.log(`🔍 [DEBUG] Targeted Date: ${todayStr}`);

    const dbLocations = await locationRepository.findActiveWithSheet();
    console.log(`📍 Found ${dbLocations.length} active locations with sheets.`);

    const incomes = await techCashService.getIncomeForDate(todayStr);
    console.log(`💰 Resulting Incomes Count: ${incomes.length}`);

    if (incomes.length > 0) {
        incomes.forEach(inc => {
            console.log(`✅ ${inc.locationName}: ${inc.totalIncome} UAH`);
        });
    } else {
        console.log("❌ No incomes found.");
    }
}

debug().catch(console.error);
