
import { PrismaClient } from "@prisma/client";
import { userRepository } from "../src/repositories/user-repository.js";

const prisma = new PrismaClient();

async function main() {
    const telegramId = BigInt(process.argv[2] || "0"); // Pass Telegram ID as CLI argument
    console.log(`Checking user ${telegramId}...`);

    console.log("--- findWithStaffProfileByTelegramId ---");
    const staffUser = await userRepository.findWithStaffProfileByTelegramId(telegramId);
    console.log("User:", staffUser?.id);
    console.log("StaffProfile:", staffUser?.staffProfile);
    console.log("IsActive:", staffUser?.staffProfile?.isActive);

    console.log("\n--- findWithProfilesByTelegramId ---");
    const fullUser = await userRepository.findWithProfilesByTelegramId(telegramId);
    console.log("User:", fullUser?.id);
    console.log("StaffProfile:", fullUser?.staffProfile);
    console.log("Candidate:", fullUser?.candidate);
    console.log("\n--- Total Users ---");
    const count = await prisma.user.count();
    console.log("Total users:", count);

    const allUsers = await prisma.user.findMany({ take: 5 });
    console.log("Sample users:", allUsers.map(u => ({ id: u.id, tgId: u.telegramId })));

    await prisma.$disconnect();
}

main().catch(console.error);
