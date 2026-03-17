import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanCityEmojis() {
    console.log("🧹 Starting city emoji cleanup...");

    const locations = await prisma.location.findMany({
        select: { id: true, city: true }
    });

    for (const loc of locations) {
        if (!loc.city) continue;

        // Remove typical emojis/symbols from city name
        const cleanCity = loc.city.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu, '').trim();

        if (cleanCity !== loc.city) {
            console.log(`✅ Cleaning city: "${loc.city}" -> "${cleanCity}"`);
            await prisma.location.update({
                where: { id: loc.id },
                data: { city: cleanCity }
            });
        }
    }

    console.log("✨ Cleanup finished.");
}

cleanCityEmojis()
    .catch(e => {
        console.error("❌ Cleanup failed:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
