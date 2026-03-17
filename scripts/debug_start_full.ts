
import { PrismaClient } from "@prisma/client";
import { userRepository } from "../src/repositories/user-repository.js";
import { workShiftRepository } from "../src/repositories/work-shift-repository.js";

const prisma = new PrismaClient();

// Simulation of showStaffHub logic
async function simulateShowStaffHub(telegramId: bigint) {
    console.log(`[Sim] simulateShowStaffHub for ${telegramId}`);
    const user = await userRepository.findWithStaffProfileByTelegramId(telegramId);

    if (!user || !user.staffProfile || !user.staffProfile.isActive) {
        console.log(`[Sim] Access denied (No staff profile or inactive)`);
        return;
    }

    console.log(`[Sim] Access granted. Staff: ${user.staffProfile.fullName}`);

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // Check shifts
    const todayShifts = await workShiftRepository.findWithLocationForStaff(user.staffProfile.id, now, 1);
    console.log(`[Sim] Today shifts found: ${todayShifts.length}`);
    if (todayShifts.length > 0) {
        console.log(`[Sim] First shift date: ${todayShifts[0].date}`);
        console.log(`[Sim] Is today? ${todayShifts[0].date.getTime() === now.getTime()}`);
    }
}

async function main() {
    // Find a staff user
    const staffUser = await prisma.user.findFirst({
        where: { staffProfile: { isActive: true } }
    });

    if (!staffUser) {
        console.log("No staff user found to test.");
        return;
    }

    const userId = staffUser.telegramId;
    console.log(`Testing for user ${userId} (${staffUser.id})`);

    // 1. Command Start Logic
    const user = await userRepository.findWithProfilesByTelegramId(userId);
    console.log(`[Cmd] User found: ${!!user}`);
    console.log(`[Cmd] Staff Profile: ${!!user?.staffProfile}`);
    console.log(`[Cmd] Is Active: ${user?.staffProfile?.isActive}`);

    if (user?.staffProfile?.isActive) {
        console.log(`[Cmd] Entering Staff Hub...`);
        await simulateShowStaffHub(userId);
    } else {
        console.log(`[Cmd] Not staff or inactive.`);
    }
}

main()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
