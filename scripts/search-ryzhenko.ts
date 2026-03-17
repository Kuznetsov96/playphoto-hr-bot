import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const user = await prisma.user.findFirst({
            where: {
                OR: [
                    { firstName: { contains: 'Риженко' } },
                    { lastName: { contains: 'Риженко' } },
                    { staffProfile: { fullName: { contains: 'Риженко' } } }
                ]
            },
            include: {
                staffProfile: true,
                chatLogs: {
                    orderBy: { createdAt: 'desc' },
                    take: 50
                }
            }
        });

        if (!user) {
            console.log("User 'Риженко' not found in database.");
            return;
        }

        console.log(`Found user: ${user.firstName} ${user.lastName} (TG: ${user.telegramId})`);
        if (user.staffProfile) {
            console.log(`Staff Profile: ${user.staffProfile.fullName}`);
        }

        console.log("\nRecent Chat Logs:");
        user.chatLogs.forEach(log => {
            const time = log.createdAt.toLocaleString('uk-UA');
            const direction = log.direction === 'IN' ? 'USER' : 'BOT';
            const text = log.text || "";
            console.log(`[${time}] ${direction}: ${text}`);
        });

    } catch (error: any) {
        console.error("Error:", error.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();
