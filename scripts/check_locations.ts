
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("🔍 Checking Location Configurations...");
    const locations = await prisma.location.findMany({
        select: {
            name: true,
            city: true,
            fopId: true,
            terminalId: true,
            searchId: true,
            hasAcquiring: true
        }
    });

    console.table(locations.map(l => ({
        Name: l.name,
        City: l.city,
        FOP: l.fopId,
        TerminalID: l.terminalId,
        SearchID: l.searchId
    })));
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
