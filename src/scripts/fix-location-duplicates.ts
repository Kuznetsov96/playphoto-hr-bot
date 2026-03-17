import prisma from "../db/core.js";
import logger from "../core/logger.js";

const CITY_MAP_EN: Record<string, string> = {
    "Львів": "Lviv",
    "🦁 Lviv": "Lviv",
    "Київ": "Kyiv",
    "🏛 Kyiv": "Kyiv",
    "Рівне": "Rivne",
    "🌲 Rivne": "Rivne",
    "Черкаси": "Cherkasy",
    "🏰 Cherkasy": "Cherkasy",
    "Запоріжжя": "Zaporizhzhia",
    "⚡️ Zaporizhzhia": "Zaporizhzhia",
    "Харків": "Kharkiv",
    "🎓 Kharkiv": "Kharkiv",
    "Коломия": "Kolomyya",
    "🌸 Kolomyia": "Kolomyya",
    "Самбір": "Sambir",
    "🍬 Sambir": "Sambir",
    "Шептицький": "Sheptytskyi",
    "⛪️ Sheptytskyi": "Sheptytskyi",
    "Хмельницький": "Khmelnytskyi",
    "🏔 Khmelnytskyi": "Khmelnytskyi"
};

const MERGE_MAP: Record<string, string> = {
    "leoland": "cmldqtxui005hc9uqk3evghrs",
    "dh_khmelnytskyi": "cmldqtxul005ic9uq7psu8vfn",
    "dragon_p": "cmldqtxun005jc9uqf2of2fii",
    "drive_city": "cmldqtxuo005kc9uqiln7t6zu",
    "fk_kyiv": "cmldqtxur005lc9uq3slw59uu",
    "fk_lviv": "cmldqtxut005mc9uqgzc2ynom",
    "fk_rivne": "cmldqtxuu005nc9uqkwx4m3jl",
    "ft_cherkasy": "cmldqtxuv005oc9uq3i49xg0d",
    "sp_darynok": "cmldqtxuy005pc9uq2l07uidq",
    "sp_kyiv": "cmldqtxuz005qc9uql6ls9qtp",
    "sp_lviv": "cmldqtxv1005rc9uq880cznys",
    "volkland_1": "cmldqtxv3005sc9uq16yknokp",
    "volkland_2": "cmldqtxv5005tc9uqvv968ld3",
    "volkland_3": "cmldqtxv7005uc9uqzaqo1lkr",
    "karamel_k": "cmldqtxv9005vc9uqhbs474yk",
    "karamel_s": "cmldqtxvc005wc9uqvy953b95",
    "karamel_ch": "cmldqtxve005xc9uqujw7po5e",
    "sp_kharkiv": "cmldqtxvg005yc9uq62thvy10"
};

async function fixDuplicates() {
    logger.info("🚀 Starting location merge and cleanup...");

    const allLocs = await prisma.location.findMany();
    logger.info(`Found ${allLocs.length} total locations.`);

    for (const [financeId, sysId] of Object.entries(MERGE_MAP)) {
        const financeLoc = allLocs.find(l => l.id === financeId);
        const sysLoc = allLocs.find(l => l.id === sysId);

        if (financeLoc && sysLoc) {
            logger.info(`Merging ${financeId} into ${sysId}...`);
            await prisma.location.update({
                where: { id: sysId },
                data: {
                    sheet: financeLoc.sheet,
                    terminalId: financeLoc.terminalId,
                    searchId: financeLoc.searchId,
                    hasAcquiring: financeLoc.hasAcquiring,
                    cashInEnvelope: financeLoc.cashInEnvelope,
                    fopId: financeLoc.fopId,
                    name: financeLoc.name, // Use the official name from finance config
                    city: CITY_MAP_EN[financeLoc.city] || financeLoc.city
                }
            });

            // Delete the finance record
            await prisma.location.delete({ where: { id: financeId } });
            logger.info(`✅ Successfully merged and deleted ${financeId}`);
        } else {
            logger.warn(`⚠️ Could not find both records for ${financeId} -> ${sysId}`);
            if (sysLoc) {
                // At least normalize city for sysLoc
                await prisma.location.update({
                    where: { id: sysId },
                    data: { city: CITY_MAP_EN[sysLoc.city] || sysLoc.city }
                });
            }
        }
    }

    // Final sweep to normalize any remaining cities
    const remainingLocs = await prisma.location.findMany();
    for (const loc of remainingLocs) {
        const normalizedCity = CITY_MAP_EN[loc.city] || loc.city;
        if (loc.city !== normalizedCity) {
            await prisma.location.update({
                where: { id: loc.id },
                data: { city: normalizedCity }
            });
        }
    }

    const finalCount = await prisma.location.count();
    logger.info(`🏁 Cleanup complete! Final location count: ${finalCount}`);
}

fixDuplicates().catch(e => logger.error(`💥 Error: ${e.message}`));
