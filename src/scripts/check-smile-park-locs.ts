import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const locs = await prisma.location.findMany({
            where: {
                name: { contains: 'Smile Park' }
            }
        });
        console.log(JSON.stringify(locs, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}
main();
