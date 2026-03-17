import prisma from "../src/db/core.js";

async function checkUser() {
    const telegramId = BigInt(process.argv[2] || "0"); // Pass Telegram ID as CLI argument
    const user = await prisma.user.findUnique({
        where: { telegramId }
    });
    console.log("User in DB:", user);
}

checkUser().finally(() => prisma.$disconnect());
