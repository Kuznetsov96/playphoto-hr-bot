import prisma from '../src/db/core.js';

async function check() {
    const locations = await prisma.location.findMany();
    console.log(`\nFound ${locations.length} total locations.\n`);

    locations.forEach(l => {
        console.log(`- ID: ${l.id} | Name: ${l.name} | City: ${l.city} | FOP: ${l.fopId} | SearchID: ${l.searchId}`);
    });
}

check();
