import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function listStaff() {
    console.log("Listing active staff members...");
    try {
        const staff = await prisma.staffProfile.findMany({
            include: {
                user: true,
                location: true
            }
        });

        console.log(`Found ${staff.length} staff records in total.`);

        staff.forEach(s => {
            console.log(`- [${s.isActive ? "ACTIVE" : "INACTIVE"}] ${s.fullName} | TG: ${s.user?.telegramId} | UserID: ${s.userId}`);
        });

    } catch (e) {
        console.error("Failed to list staff:", e);
    } finally {
        await prisma.$disconnect();
    }
}

listStaff();
