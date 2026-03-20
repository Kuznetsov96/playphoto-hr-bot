import { Composer } from "grammy";
import type { MyContext } from "../../types/context.js";
import { candidateHandlers } from "./handlers/index.js";
import { 
    candidateGenderMenu, 
    candidateCityMenu, 
    candidateLocationMenu, 
    candidateAppearanceMenu, 
    candidateSourceMenu 
} from "../../menus/candidate.js";
import { supportHandlers, handleSupportMessage } from "../../handlers/support.js";
import { bot } from "../../core/bot.js";

export const candidateModule = new Composer<MyContext>();

// 1. Register candidate menus
candidateModule.use(candidateGenderMenu);
candidateModule.use(candidateCityMenu);
candidateModule.use(candidateLocationMenu);
candidateModule.use(candidateAppearanceMenu);
candidateModule.use(candidateSourceMenu);

// 2. Register specific candidate handlers (screening, commands)
candidateModule.use(candidateHandlers);

// 2. Register candidate support callbacks
candidateModule.use(supportHandlers);

// 3. Handle Messages (Support Flow for Candidates)
candidateModule.on("message", async (ctx, next) => {
    // Attempt to handle as support message
    const handled = await handleSupportMessage(ctx);
    if (handled) return;

    // --- CATCH-ALL FOR CANDIDATES ---
    // If we are here, it means the message wasn't caught by screening or support
    const { candidateRepository } = await import("../../repositories/candidate-repository.js");
    const candidate = await candidateRepository.findByTelegramId(ctx.from!.id);
    
    if (candidate) {
        const { showCandidateStatus } = await import("../../utils/candidate-ui.js");
        const fullName = candidate.fullName || ctx.from?.first_name || "Кандидатко";
        const firstName = fullName.split(" ")[0];
        
        await ctx.reply(`🤔 <b>${firstName}, я не зовсім зрозумів твоє повідомлення.</b>\n\nОсь твій поточний статус: 👇`, { parse_mode: "HTML" });
        await showCandidateStatus(ctx, candidate);
        return;
    }

    await next();
});
