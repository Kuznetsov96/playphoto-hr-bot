
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const telegramId = BigInt(process.argv[2] || "0"); // Pass Telegram ID as CLI argument
    console.log(`Restoring staff profile for ${telegramId}...`);

    // 1. Create/Upsert User
    const user = await prisma.user.upsert({
        where: { telegramId },
        update: {},
        create: {
            telegramId,
            firstName: "Тест",
            lastName: "Тестович",
            username: "test_tech",
            role: "ADMIN" // Or whatever role is appropriate, Staff usually have candidate role? No, let's leave default or set to ADMIN.
        }
    });

    console.log(`User upserted: ${user.id}`);

    // 2. Create Staff Profile
    // We need a location. Let's find first available location or 'Zaporizhzhia'.
    const location = await prisma.location.findFirst();

    if (!location) {
        throw new Error("No location found to assign");
    }

    const staff = await prisma.staffProfile.upsert({
        where: { userId: user.id },
        update: { isActive: true },
        create: {
            userId: user.id,
            fullName: "Тест Тестович Абрамович",
            phone: "+380000000000",
            locationId: location.id,
            isActive: true
        }
    });

    console.log(`Staff Profile restored: ${staff.id} (Location: ${location.name})`);

    // 3. Clear any active conversation session if possible (optional)
    // We can't easily clear session from here without session key knowledge, but /start usually resets session.

    await prisma.$disconnect();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
