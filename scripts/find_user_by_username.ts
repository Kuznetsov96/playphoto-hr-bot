import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const user = await prisma.user.findFirst({
        where: {
            OR: [
                { username: 'trand77' },
                { username: '@trand77' }
            ]
        },
        include: { staffProfile: true }
    });
    console.log(JSON.stringify(user, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
