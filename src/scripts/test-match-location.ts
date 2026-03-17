// Test the matchLocation logic directly with mock data
const locations = [
    { id: "vk1", name: "Volkland", legacyName: "Volkland 1 (Бабурка)", city: "Запоріжжя" },
    { id: "vk2", name: "Volkland 2", legacyName: "Volkland 2 (Шевчик)", city: "Запоріжжя" },
    { id: "vk3", name: "Volkland 3", legacyName: "Volkland 3 (Перемоги)", city: "Запоріжжя" },
    { id: "sp1", name: "Smile Park (Darynok)", legacyName: "", city: "Київ" },
    { id: "fk1", name: "Fly Kids", legacyName: "", city: "Київ" },
];

function matchLocation(locStr: string, locs: typeof locations) {
    const sLoc = locStr.trim().toLowerCase();
    if (!sLoc) return null;

    return locs.find(l => {
        const lName = l.name.toLowerCase();
        const lLegacy = (l.legacyName || "").toLowerCase();
        const lCity = (l.city || "").toLowerCase();

        if (sLoc === lName || sLoc === lLegacy) return true;

        const normalizedSheetLoc = sLoc
            .replace(/^fk\s+/g, 'fly kids ')
            .replace(/^sp\s+/g, 'smile park ')
            .replace(/^dp\s+/g, 'dragon park ')
            .replace(/^dragonp$/g, 'dragon park')
            .replace(/^leoland$/g, 'leolend')
            .replace(/^leo$/g, 'leolend')
            .replace(/^dh\s+/g, 'dytyache horyshche ');

        const normalizedDbName = lName.replace(/\(.*\)/g, '').trim();

        // City-aware match
        if (lCity && sLoc.includes(lCity)) {
            if (normalizedSheetLoc.includes(normalizedDbName) ||
                normalizedDbName.includes(normalizedSheetLoc)) {
                const sheetNum = normalizedSheetLoc.match(/(\d+)\s*$/)?.[1] || null;
                const dbNum = normalizedDbName.match(/(\d+)\s*$/)?.[1] || null;
                if (sheetNum || dbNum) {
                    if (sheetNum === dbNum) return true;
                } else {
                    return true;
                }
            }
            if (lLegacy.includes(sLoc) || sLoc.includes(lLegacy)) return true;
        }

        const otherCities = ["київ", "львів", "харків", "рівне", "запоріжжя", "коломия", "самбір", "хмельницький", "черкаси"];
        const mentionedCity = otherCities.find(c => sLoc.includes(c));
        if (mentionedCity && lCity && mentionedCity !== lCity) return false;

        // General match with number guard
        if (normalizedSheetLoc.includes(normalizedDbName) ||
            normalizedDbName.includes(normalizedSheetLoc)) {
            const sheetNum = normalizedSheetLoc.match(/(\d+)\s*$/)?.[1] || null;
            const dbNum = normalizedDbName.match(/(\d+)\s*$/)?.[1] || null;
            if (sheetNum || dbNum) {
                return sheetNum === dbNum;
            }
            return true;
        }

        if (lLegacy.includes(sLoc) || sLoc.includes(lLegacy)) return true;

        return false;
    }) || null;
}

// Test cases
const tests = [
    { input: "Volkland", expected: "vk1" },
    { input: "Volkland 2", expected: "vk2" },
    { input: "Volkland 3", expected: "vk3" },
    { input: "volkland", expected: "vk1" },
    { input: "volkland 2", expected: "vk2" },
    { input: "Smile Park (Darynok)", expected: "sp1" },
    { input: "SP Київ", expected: "sp1" },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
    const result = matchLocation(t.input, locations);
    const ok = result?.id === t.expected;
    if (ok) {
        console.log(`✅ "${t.input}" → ${result?.name} (${result?.id})`);
        passed++;
    } else {
        console.log(`❌ "${t.input}" → ${result?.name || 'null'} (${result?.id || 'null'}) — expected ${t.expected}`);
        failed++;
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
