import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function checkUser() {
    const name = "Мостова Ярина Володимирівна";
    console.log(`Searching for "${name}"...`);

    const staffProfile = await prisma.staffProfile.findFirst({
        where: {
            fullName: {
                contains: name,
                mode: 'insensitive'
            }
        },
        include: {
            user: true
        }
    });

    if (staffProfile) {
        console.log("✅ Staff profile found:");
        console.log(JSON.stringify(staffProfile, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value, 2));
    } else {
        console.log("❌ Staff profile not found.");
    }

    const user = await prisma.user.findFirst({
        where: {
            OR: [
                { firstName: { contains: "Ярина", mode: 'insensitive' } },
                { lastName: { contains: "Мостова", mode: 'insensitive' } }
            ]
        },
        include: {
            staffProfile: true
        }
    });

    if (user) {
        console.log("\n✅ User found by name parts:");
        console.log(JSON.stringify(user, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value, 2));
    } else {
        console.log("❌ User not found by name parts.");
    }

    await prisma.$disconnect();
}

checkUser();
