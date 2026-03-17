import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function debugMostova() {
    console.log("🔍 Searching for 'Мостова' in database...");
    try {
        const staff = await prisma.staffProfile.findMany({
            where: {
                fullName: { contains: "Мостова", mode: 'insensitive' }
            },
            include: {
                user: true,
                location: true
            }
        });

        if (staff.length === 0) {
            console.log("❌ No staff profile found for 'Мостова'");
        } else {
            console.log(`✅ Found ${staff.length} staff profiles:`);
            staff.forEach(s => {
                console.log("--- STAFF PROFILE ---");
                console.log(`ID: ${s.id}`);
                console.log(`Full Name: ${s.fullName}`);
                console.log(`Phone: ${s.phone}`);
                console.log(`Active: ${s.isActive}`);
                console.log(`User ID: ${s.userId}`);
                console.log(`TG ID: ${s.user?.telegramId}`);
                console.log(`Location: ${s.location?.name} (${s.location?.city})`);
            });
        }

        const candidates = await prisma.candidate.findMany({
            where: {
                fullName: { contains: "Мостова", mode: 'insensitive' }
            },
            include: {
                user: true
            }
        });

        if (candidates.length > 0) {
            console.log(`✅ Found ${candidates.length} candidate profiles:`);
            candidates.forEach(c => {
                console.log("--- CANDIDATE PROFILE ---");
                console.log(`ID: ${c.id}`);
                console.log(`Full Name: ${c.fullName}`);
                console.log(`Status: ${c.status}`);
                console.log(`TG ID: ${c.user?.telegramId}`);
            });
        }

    } catch (e) {
        console.error("❌ Diagnostic failed:", e);
    } finally {
        await prisma.$disconnect();
    }
}

debugMostova();
