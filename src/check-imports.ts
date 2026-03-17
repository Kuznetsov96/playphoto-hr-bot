
import * as dotenv from "dotenv";
dotenv.config();

console.log("🔍 Checking imports...");

try {
    console.log("👉 Importing config...");
    const config = await import("./config.js");
    console.log("✅ Config loaded. ADMIN_IDS:", config.ADMIN_IDS);

    console.log("👉 Importing admin handlers...");
    const admin = await import("./handlers/admin/index.js");
    console.log("✅ Admin handlers loaded.");

    console.log("👉 Importing command handlers...");
    const commands = await import("./handlers/commands.js");
    console.log("✅ Command handlers loaded.");

    console.log("🎉 All imports successful!");
} catch (e) {
    console.error("❌ Import failed:", e);
    process.exit(1);
}
