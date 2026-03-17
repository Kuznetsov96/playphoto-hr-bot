import prisma from "../db/core.js";

async function main() {
    const locs = await prisma.location.findMany({
        where: { isHidden: false },
        select: { id: true, name: true, city: true, sheet: true }
    });
    console.log(`Total active locations: ${locs.length}`);
    const withSheet = locs.filter(l => l.sheet);
    console.log(`With sheet: ${withSheet.length}`);
    if (withSheet.length > 0) {
        withSheet.forEach(l => console.log(`  ✅ ${l.name} (${l.city}) → "${l.sheet}"`));
    }
    const withoutSheet = locs.filter(l => !l.sheet);
    console.log(`Without sheet: ${withoutSheet.length}`);
    withoutSheet.forEach(l => console.log(`  ❌ ${l.name} (${l.city}) → sheet: ${l.sheet}`));
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
