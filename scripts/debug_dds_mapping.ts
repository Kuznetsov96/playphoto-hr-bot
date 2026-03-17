import { syncToDDS } from "../dist/services/finance-report.js";
import prisma from "../dist/db/core.js";

async function test() {
    const dateStr = "15.02.2026";
    console.log(`🧪 Testing UPDATED DDS Mapping for ${dateStr} (Dry Run)...`);

    try {
        const res = await syncToDDS(dateStr, undefined, true);
        console.log("\n📋 DRY RUN LOG:");
        console.log(res.message);
    } catch (e) {
        console.error("❌ Error during test:", e);
    } finally {
        await prisma.$disconnect();
    }

    console.log("\n✅ Test completed successfully.");
}

test();
