import prisma from "../db/core.js";
import logger from "../core/logger.js";

async function main() {
    try {
        const result = await prisma.session.deleteMany({
            where: {
                key: {
                    startsWith: 'mono_client_info'
                }
            }
        });
        console.log(`✅ Deleted ${result.count} old Monobank cache entries from Prisma.`);
    } catch (e) {
        console.error("❌ Cleanup failed:", e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
