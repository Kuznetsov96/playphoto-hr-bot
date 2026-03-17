import prisma from "../db/core.js";
import { scheduleSyncService } from "../services/schedule-sync.js";

async function main() {
    console.log("=== BEFORE SYNC ===");
    const before = await prisma.staffProfile.findMany({
        where: { isActive: true, location: { city: 'Запоріжжя' } },
        select: { fullName: true, location: { select: { name: true } } }
    });
    before.forEach(s => console.log(`  ${s.fullName} → ${s.location?.name}`));

    console.log("\n=== RUNNING TEAM SYNC ===");
    const result = await scheduleSyncService.syncTeam();
    console.log(JSON.stringify(result, null, 2));

    console.log("\n=== AFTER SYNC ===");
    const after = await prisma.staffProfile.findMany({
        where: { isActive: true, location: { city: 'Запоріжжя' } },
        select: { fullName: true, location: { select: { name: true } } }
    });
    after.forEach(s => console.log(`  ${s.fullName} → ${s.location?.name}`));

    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
