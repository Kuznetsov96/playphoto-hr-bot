import { bot } from "../core/bot.js";
import { userRepository } from "../repositories/user-repository.js";
import { accessService } from "./access-service.js";
import logger from "../core/logger.js";

export const restoreAccessService = {
    /**
     * Finds all authorized users and sends them an invite link if they are not in the channel.
     * Use this to recover from accidental mass kicks.
     */
    async restoreAllStaffAccess(adminApi: any) {
        logger.info("🛠 Starting mass access restoration...");
        
        const allUsers = await userRepository.findAllWithProfiles();
        let processed = 0;
        let invited = 0;
        let failed = 0;

        // Process in small batches to avoid Telegram rate limits
        const batchSize = 3;
        for (let i = 0; i < allUsers.length; i += batchSize) {
            const batch = allUsers.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (user) => {
                if (!user.telegramId) return;
                
                try {
                    // ONLY notify active STAFF for mass restoration (Apple Style: Target relevant users only)
                    if (user.role !== 'STAFF' || !user.staffProfile?.isActive) return;

                    processed++;
                    const inviteLink = await accessService.createInviteLink(user.telegramId);
                    
                    if (inviteLink) {
                        const message = `👋 <b>Поновлення доступу!</b>

` +
                            `Ми оновили систему безпеки каналу. Будь ласка, повернись до нашої спільноти за цим посиланням:

` +
                            `🔗 <a href="${inviteLink}">Приєднатися до каналу PlayPhoto</a>

` +
                            `Це посилання одноразове та діє тільки для тебе. ✨`;
                        
                        await bot.api.sendMessage(Number(user.telegramId), message, { parse_mode: "HTML" });
                        invited++;
                    }
                } catch (e: any) {
                    logger.error({ err: e, userId: user.telegramId }, "Failed to restore access for user");
                    failed++;
                }
            }));

            // Small delay between batches
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const summary = `✅ <b>Access Restoration Complete</b>

` +
            `• Users checked: ${allUsers.length}
` +
            `• Authorized & Notified: ${invited}
` +
            `• Failed: ${failed}`;
        
        return summary;
    }
};
