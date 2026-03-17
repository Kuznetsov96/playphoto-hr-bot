
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const telegramId = process.argv[2] || "0"; // Pass Telegram ID as CLI argument
    console.log(`Clearing session for ${telegramId}...`);

    try {
        const deleted = await prisma.session.deleteMany({
            where: { key: telegramId }
        });
        console.log(`Deleted ${deleted.count} session(s).`);
    } catch (e) {
        console.error("Error deleting session:", e);
    }

    await prisma.$disconnect();
}

main().catch(console.error);
