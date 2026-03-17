const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const messages = await prisma.message.findMany({
        where: {
            photoId: { not: null },
            createdAt: { gte: today }
        },
        include: {
            candidate: true
        },
        orderBy: { createdAt: 'desc' }
    });

    if (messages.length === 0) {
        console.log("DATABASE_RESULT: NONE");
    } else {
        console.log("DATABASE_RESULT: FOUND " + messages.length);
        for (const msg of messages) {
            console.log("DATE: " + msg.createdAt.toISOString());
            console.log("CANDIDATE: " + (msg.candidate ? msg.candidate.fullName : "Unknown"));
            console.log("SCOPE: " + msg.scope);
            console.log("PHOTO_ID: " + msg.photoId);
            console.log("---");
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
