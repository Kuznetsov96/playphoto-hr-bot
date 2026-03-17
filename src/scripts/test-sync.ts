import { scheduleSyncService } from "../services/schedule-sync.js";
import logger from "../core/logger.js";

async function runLocalSync() {
    console.log("🚀 Starting local team sync...");
    try {
        const result = await scheduleSyncService.syncTeam();
        console.log("✅ Sync result:", result);

        // After sync, check if She exists
        const prisma = (await import("../db/core.js")).default;
        const staff = await prisma.staffProfile.findMany({
            where: { fullName: { contains: "Мостова", mode: 'insensitive' } },
            include: { user: true }
        });

        if (staff.length > 0) {
            console.log("✅ Found her in DB after sync:");
            staff.forEach((s: any) => {
                console.log(`FullName: ${s.fullName}, TG: ${s.user?.telegramId}, Active: ${s.isActive}`);
            });
        } else {
            console.log("❌ Still not found in DB after sync.");
        }
    } catch (e) {
        console.error("❌ Sync failed:", e);
    }
}

runLocalSync();
