import prisma from "../db/core.js";

async function main() {
    const locs = await prisma.location.findMany({
        where: { city: 'Запоріжжя' },
        select: { id: true, name: true, legacyName: true }
    });
    console.log("=== LOCATIONS ===");
    console.log(JSON.stringify(locs, null, 2));

    const staff = await prisma.staffProfile.findMany({
        where: { isActive: true, location: { city: 'Запоріжжя' } },
        select: { fullName: true, locationId: true, location: { select: { name: true } } }
    });
    console.log("\n=== STAFF ===");
    staff.forEach(s => console.log(`${s.fullName} → ${s.location?.name} (${s.locationId})`));

    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
