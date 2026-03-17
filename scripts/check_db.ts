import { PrismaClient } from "@prisma/client";
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
        console.log("DATABASE_CHECK: No photos found today.");
    } else {
        console.log(\`DATABASE_CHECK: Found \${messages.length} photos today:\`);
        messages.forEach(msg => {
            console.log(\`[\${msg.createdAt.toISOString()}] \${msg.candidate?.fullName || 'Unknown'} (\${msg.candidate?.status || 'N/A'}) - Scope: \${msg.scope}\`);
            console.log(\`  PhotoID: \${msg.photoId}\`);
            console.log(\`  Content: \${msg.content}\`);
        });
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
