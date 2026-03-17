import prisma from "../db/core.js";

const sheetMapping: Record<string, string> = {
    // name in DB -> sheet name in Google Sheets
    "Smile Park (Darynok)": "SP Даринок",
    "Fly Kids": "FK Київ",          // Київ
    "Leolend": "Leoland",
    "Drive City": "DriveCity",
    "Dragon Park": "DragonP",
    // Fly Kids Львів - need city to disambiguate
    "Smile Park": "SP Львів",        // Львів - need city
    "Volkland": "Volkland",           // Запоріжжя
    "Volkland 2": "Volkland 2",
    "Volkland 3": "Volkland 3",
    "Karamel": "Карамель К",          // Коломия - need city
    "Fly Kids Рівне": "FK Рівне",    // handled via city
    "Fantasy Town": "FT Черкаси",
    "Smile Park Київ": "SP Київ",     // handled via city
    "Smile Park Харків": "SP Харків",  // handled via city
    "Dytyache Horyshche": "DH Khmelnytskyi",
};

// More precise mapping using name + city
const mapping: { name: string; city: string; sheet: string }[] = [
    { name: "Smile Park (Darynok)", city: "Київ", sheet: "SP Даринок" },
    { name: "Fly Kids", city: "Київ", sheet: "FK Київ" },
    { name: "Leolend", city: "Львів", sheet: "Leoland" },
    { name: "Drive City", city: "Львів", sheet: "DriveCity" },
    { name: "Dragon Park", city: "Львів", sheet: "DragonP" },
    { name: "Fly Kids", city: "Львів", sheet: "FK Львів" },
    { name: "Smile Park", city: "Львів", sheet: "SP Львів" },
    { name: "Volkland", city: "Запоріжжя", sheet: "Volkland" },
    { name: "Volkland 2", city: "Запоріжжя", sheet: "Volkland 2" },
    { name: "Volkland 3", city: "Запоріжжя", sheet: "Volkland 3" },
    { name: "Karamel", city: "Коломия", sheet: "Карамель К" },
    { name: "Karamel", city: "Шептицький", sheet: "Карамель Ч" },
    { name: "Fly Kids", city: "Рівне", sheet: "FK Рівне" },
    { name: "Fantasy Town", city: "Черкаси", sheet: "FT Черкаси" },
    { name: "Smile Park", city: "Київ", sheet: "SP Київ" },
    { name: "Smile Park", city: "Харків", sheet: "SP Харків" },
    { name: "Karamel", city: "Самбір", sheet: "Карамель С" },
    { name: "Dytyache Horyshche", city: "Хмельницький", sheet: "DH Khmelnytskyi" },
];

async function main() {
    const locs = await prisma.location.findMany({ where: { isHidden: false } });
    console.log(`Found ${locs.length} active locations\n`);

    let updated = 0;
    let notFound = 0;

    for (const m of mapping) {
        const loc = locs.find(l => l.name === m.name && l.city === m.city);
        if (loc) {
            await prisma.location.update({
                where: { id: loc.id },
                data: { sheet: m.sheet }
            });
            console.log(`  ✅ ${loc.name} (${loc.city}) → "${m.sheet}"`);
            updated++;
        } else {
            console.log(`  ❌ NOT FOUND: "${m.name}" in "${m.city}"`);
            notFound++;
        }
    }

    // Check if any locations still missing sheet
    const afterUpdate = await prisma.location.findMany({ where: { isHidden: false, sheet: null } });
    if (afterUpdate.length > 0) {
        console.log(`\n⚠️  ${afterUpdate.length} locations still without sheet:`);
        afterUpdate.forEach(l => console.log(`   • ${l.name} (${l.city})`));
    }

    console.log(`\n✅ Updated: ${updated}, Not found: ${notFound}`);
    await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
