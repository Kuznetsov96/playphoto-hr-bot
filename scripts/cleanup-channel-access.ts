import { userRepository } from "../src/repositories/user-repository.js";
import { accessService } from "../src/services/access-service.js";
import { legacyAccessService } from "../src/services/legacy-access-service.js";
import { ADMIN_IDS, CO_FOUNDER_IDS, SUPPORT_IDS, MENTOR_IDS, HR_IDS } from "../src/config.js";
import logger from "../src/core/logger.js";

async function cleanup() {
    logger.info("🚀 Starting global channel access cleanup (including Legacy Spreadsheet)...");
    
    // 1. Fetch legacy IDs from spreadsheet
    const legacyIds = await legacyAccessService.getAllowedIds();
    
    // 2. Combine with static Admin IDs from config (safety first)
    const adminIds = new Set<bigint>([
        ...ADMIN_IDS, ...CO_FOUNDER_IDS, ...SUPPORT_IDS, ...MENTOR_IDS, ...HR_IDS
    ].map(id => BigInt(id)));

    // 3. Fetch all users from DB
    const dbUsers = await userRepository.findAllWithProfiles();
    
    // 4. Create a master list of IDs to check
    // We check EVERYONE we know about.
    const allKnownIds = new Set<bigint>();
    dbUsers.forEach(u => allKnownIds.add(u.telegramId));
    legacyIds.forEach(id => allKnownIds.add(id));
    adminIds.forEach(id => allKnownIds.add(id));

    logger.info(`Total unique users to verify: ${allKnownIds.size}`);
    
    let revoked = 0;
    let checked = 0;
    let skipped = 0;
    let errors = 0;

    for (const tid of allKnownIds) {
        checked++;
        
        // Safety check: is authorized by DB logic OR is in legacy spreadsheet OR is admin
        const isDbAuthorized = await accessService.isAuthorized(tid);
        const isLegacyAuthorized = legacyIds.has(tid);
        const isAdmin = adminIds.has(tid);

        const shouldHaveAccess = isDbAuthorized || isLegacyAuthorized || isAdmin;

        if (!shouldHaveAccess) {
            try {
                // Check if they are actually in the chat
                const member = await accessService.bot.api.getChatMember(accessService.chatId, Number(tid));
                
                // statuses: 'creator', 'administrator', 'member', 'restricted', 'left', 'kicked'
                if (['member', 'restricted'].includes(member.status)) {
                    logger.info({ telegramId: tid }, "🚫 Revoking unauthorized access");
                    await accessService.revokeAccess(tid);
                    revoked++;
                } else {
                    skipped++;
                }
            } catch (e: any) {
                // description: "Forbidden: bot was kicked from the channel" or "user not found"
                if (e.description?.includes("user is not a member")) {
                    skipped++;
                } else {
                    errors++;
                    logger.error({ err: e.message, tid }, "Error checking member status");
                }
            }
        } else {
            skipped++;
        }
        
        if (checked % 50 === 0) {
            logger.info(`Progress: ${checked}/${allKnownIds.size} (Revoked: ${revoked}, Skipped: ${skipped})...`);
        }

        // Avoid Telegram flood limits (approx 30 req/sec)
        // Using 300ms (3 req/sec) for maximum safety margin as requested.
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    logger.info(`✅ Cleanup finished!`);
    logger.info(`Summary:`);
    logger.info(`- Total checked: ${checked}`);
    logger.info(`- Actually removed: ${revoked}`);
    logger.info(`- Stayed/Not in chat: ${skipped}`);
    logger.info(`- API Errors: ${errors}`);
}

cleanup().catch(console.error).finally(() => process.exit());
