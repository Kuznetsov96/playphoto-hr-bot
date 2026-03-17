
import { PrismaClient } from "@prisma/client";
import { userRepository } from "../src/repositories/user-repository.js";

const prisma = new PrismaClient();

async function main() {
    // We can try to find a user with a staff profile to test
    console.log("Searching for users with staff profile...");
    const staffUsers = await prisma.user.findMany({
        where: {
            staffProfile: {
                isNot: null
            }
        },
        include: {
            staffProfile: true
        },
        take: 5
    });

    console.log(`Found ${staffUsers.length} staff users.`);

    for (const u of staffUsers) {
        console.log(`--------------------------------`);
        console.log(`User ID: ${u.id}, Telegram ID: ${u.telegramId}`);
        console.log(`Staff Profile:`, u.staffProfile);

        const userRepoResult = await userRepository.findWithProfilesByTelegramId(u.telegramId);
        console.log(`Repo Result (findWithProfilesByTelegramId):`, {
            id: userRepoResult?.id,
            hasStaffProfile: !!userRepoResult?.staffProfile,
            isActive: userRepoResult?.staffProfile?.isActive
        });
    }
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
