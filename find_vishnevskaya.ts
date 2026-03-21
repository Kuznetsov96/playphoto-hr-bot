import prisma from './src/db/core.js';

async function main() {
    try {
        const users = await prisma.user.findMany({
            where: {
                OR: [
                    { name: { contains: 'Вишневська', mode: 'insensitive' } },
                    { telegramId: { contains: 'Вишневська', mode: 'insensitive' } }
                ]
            }
        });
        console.log('Users found:', JSON.stringify(users, null, 2));

        const candidates = await prisma.candidate.findMany({
            where: {
                OR: [
                    { firstName: { contains: 'Вишневська', mode: 'insensitive' } },
                    { lastName: { contains: 'Вишневська', mode: 'insensitive' } }
                ]
            }
        });
        console.log('Candidates found:', JSON.stringify(candidates, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
