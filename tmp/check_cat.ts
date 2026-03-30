import prisma from '../src/db/core.js';

async function checkCandidate() {
    try {
        const user = await prisma.user.findFirst({
            where: { username: 'sswijig' },
            include: { candidate: true }
        });

        if (!user) {
            console.log("No user found with username 'sswijig'");
            return;
        }

        console.log("User:", JSON.stringify(user, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

        if (user.candidate?.id) {
            const timeline = await prisma.userTimelineEvent.findMany({
                where: { userId: user.id },
                orderBy: { createdAt: 'desc' },
                take: 5
            });
            console.log("Timeline events:", JSON.stringify(timeline, null, 2));
        }

    } catch (e) {
        console.error("Error checking candidate:", e);
    } finally {
        await prisma.$disconnect();
    }
}

checkCandidate();
