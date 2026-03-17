import prisma from "../db/core.js";
import { FINANCE_LOCATIONS } from "../config.js";
import logger from "../core/logger.js";

async function migrate() {
    logger.info("🚀 Starting configuration migration to DB...");

    for (const loc of FINANCE_LOCATIONS) {
        try {
            const updated = await prisma.location.upsert({
                where: { id: loc.id },
                update: {
                    sheet: loc.sheet,
                    terminalId: loc.terminalId || null,
                    searchId: loc.searchId || null,
                    hasAcquiring: loc.hasAcquiring || false,
                    cashInEnvelope: loc.cashInEnvelope || false,
                    fopId: loc.fopId || null,
                    name: loc.name,
                    city: loc.city,
                },
                create: {
                    id: loc.id,
                    sheet: loc.sheet,
                    terminalId: loc.terminalId || null,
                    searchId: loc.searchId || null,
                    hasAcquiring: loc.hasAcquiring || false,
                    cashInEnvelope: loc.cashInEnvelope || false,
                    fopId: loc.fopId || null,
                    name: loc.name,
                    city: loc.city,
                }
            });
            logger.info(`✅ Migrated location: ${updated.id} (${updated.name})`);
        } catch (error: any) {
            logger.error(`❌ Failed to migrate location ${loc.id}: ${error.message}`);
        }
    }

    logger.info("🏁 Migration complete!");
}

migrate()
    .catch((e) => {
        logger.error(`💥 Fatal migration error: ${e.message}`);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
