
import * as dotenv from "dotenv";
dotenv.config();
import { scheduleSyncService } from "../services/schedule-sync.js";

async function run() {
    console.log("🚀 Running full sync (team + schedule)...\n");
    try {
        console.log("=== TEAM SYNC ===");
        const teamRes = await scheduleSyncService.syncTeam();
        console.log("Team result:", teamRes);

        console.log("\n=== SCHEDULE SYNC ===");
        const schedRes = await scheduleSyncService.syncSchedule();
        console.log("Schedule result:", schedRes);
    } catch (e) {
        console.error("❌ Error:", e);
    }
    process.exit(0);
}

run();
