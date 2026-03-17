import prisma from '../db/core.js';

async function main() {
    const locations = await prisma.location.findMany({
        orderBy: { city: 'asc' }
    });
    console.log('--- CURRENT LOCATIONS IN DATABASE ---');
    locations.forEach(l => {
        console.log(`[${l.city}] ${l.name} (ID: ${l.id})`);
    });
    await prisma.$disconnect();
}

main().catch(console.error);
