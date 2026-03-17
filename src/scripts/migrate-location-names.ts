import prisma from '../db/core.js';

/**
 * Migration script to fix location names:
 * - Move current `name` (with DDS prefix) to `legacyName`
 * - Clean `name` to contain only location name without DDS prefix
 */

/**
 * Extract clean location name from DDS-prefixed names
 */
function getCleanLocationName(locationName: string): string {
    // Remove common DDS prefixes
    const prefixes = [
        'Выручка от продаж ',
        'Виручка від продажу ',
        'Виручка від продаж ',
        'Выручка от продажу '
    ];

    let cleanName = locationName;
    for (const prefix of prefixes) {
        if (cleanName.startsWith(prefix)) {
            cleanName = cleanName.substring(prefix.length);
            break;
        }
    }

    // Remove city name from the end if it's duplicated
    // E.g., "Smile Park Kharkiv" when city is already "Kharkiv"
    const parts = cleanName.split(' ');
    if (parts.length > 1) {
        // Take all but the last word (which is usually the city)
        return parts.slice(0, -1).join(' ');
    }

    return cleanName;
}

async function migrateLocationNames() {
    console.log('🚀 Starting location name migration...\n');

    // Get all locations
    const locations = await prisma.location.findMany();
    console.log(`📊 Found ${locations.length} locations to process\n`);

    let updated = 0;
    let skipped = 0;

    for (const location of locations) {
        const currentName = location.name;
        const cleanName = getCleanLocationName(currentName);

        // Skip if name is already clean (no DDS prefix)
        if (currentName === cleanName) {
            console.log(`⏭️  SKIP: ${location.id} - "${currentName}" (already clean)`);
            skipped++;
            continue;
        }

        // Update location
        await prisma.location.update({
            where: { id: location.id },
            data: {
                name: cleanName,
                legacyName: currentName
            }
        });

        console.log(`✅ UPDATE: ${location.id}`);
        console.log(`   Old name: "${currentName}"`);
        console.log(`   New name: "${cleanName}"`);
        console.log(`   Legacy:   "${currentName}"\n`);
        updated++;
    }

    console.log('\n📈 Migration Summary:');
    console.log(`   ✅ Updated: ${updated}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   📊 Total:   ${locations.length}`);
    console.log('\n✨ Migration completed successfully!');
}

// Run migration
migrateLocationNames()
    .catch((e) => {
        console.error('❌ Migration failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
