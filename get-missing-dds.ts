import prisma from "./src/db/core.js";

async function run() {
    try {
        const shifts = await prisma.workShift.findMany({
            where: {
                date: {
                    gte: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
                }
            },
            include: {
                location: true,
                staff: { include: { user: true } }
            },
            orderBy: { date: 'desc' }
        });

        console.log(`Found ${shifts.length} shifts in the last 2 days.`);
        
        let foundGupalova = 0;
        let foundPosrednikova = 0;

        shifts.forEach(s => {
            if (s.location?.fopName?.toUpperCase() === 'GUPALOVA' || s.location?.name?.toLowerCase().includes('leoland')) {
                foundGupalova++;
                console.log(`[GUPALOVA/Leoland] ID: ${s.id} | Date: ${s.date.toLocaleDateString()} | Loc: ${s.location?.name} | Sync: ${s.isSynced}`);
            }
            if (s.location?.fopName?.toUpperCase() === 'POSREDNIKOVA') {
                foundPosrednikova++;
                console.log(`[POSREDNIKOVA] ID: ${s.id} | Date: ${s.date.toLocaleDateString()} | Loc: ${s.location?.name} | Sync: ${s.isSynced}`);
            }
        });
        
        console.log(`GUPALOVA/Leoland: ${foundGupalova}, POSREDNIKOVA: ${foundPosrednikova}`);
    } catch(e) {
        console.error("Error:", e);
    }
}
run();
