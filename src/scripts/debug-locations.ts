
import * as dotenv from "dotenv";
dotenv.config();
import prisma from "../db/core.js";

async function debugLocations() {
    const locations = await prisma.location.findMany({
        select: { id: true, name: true, legacyName: true, city: true, isHidden: true }
    });
    console.log("\n=== ALL LOCATIONS IN DB ===");
    locations.forEach(l => {
        console.log(`  [${l.isHidden ? 'HIDDEN' : 'ACTIVE'}] "${l.name}" | legacy: "${l.legacyName || '-'}" | city: ${l.city}`);
    });
    console.log(`\nTotal: ${locations.length}`);
    await prisma.$disconnect();
}

debugLocations();
