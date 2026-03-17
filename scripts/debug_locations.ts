import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const locations = await prisma.location.findMany({
        where: { isHidden: false },
        select: {
            id: true,
            name: true,
            city: true,
            fopId: true,
            searchId: true,
            terminalId: true
        }
    });

    console.log(JSON.stringify(locations, null, 2));
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
