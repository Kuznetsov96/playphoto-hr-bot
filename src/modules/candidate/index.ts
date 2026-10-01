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
import { shouldRouteMessageToPrivateRoleFlows } from "../../utils/message-routing.js";
import { CANDIDATE_TEXTS } from "../../constants/candidate-texts.js";
import { isMirroredCandidateMessage } from "../../middleware/recruiting-incoming.js";
import { redis } from "../../core/redis.js";

const FORWARDED_ACK_TTL_SECONDS = 3 * 60 * 60;

export const candidateModule = new Composer<MyContext>();

// 1. Register candidate menus
candidateModule.use(candidateGenderMenu);
candidateModule.use(candidateCityMenu);
candidateModule.use(candidateLocationMenu);
candidateModule.use(candidateAppearanceMenu);
candidateModule.use(candidateSourceMenu);

// 2. Register specific candidate handlers (screening, commands)
candidateModule.use(candidateHandlers);

// 3. Handle messages not consumed by the root support/funnel router.
candidateModule.on("message", async (ctx, next) => {
    // Candidate flows are private by design. Group/service messages must never
    // expose candidate status or advance a private funnel session.
    if (!shouldRouteMessageToPrivateRoleFlows(ctx.chat?.type)) return next();

    // --- CATCH-ALL FOR CANDIDATES ---
    // If we are here, it means the message wasn't caught by screening or support
    const { candidateRepository } = await import("../../repositories/candidate-repository.js");
    const candidate = await candidateRepository.findByTelegramId(ctx.from!.id);
    
    if (candidate && ctx.session.step?.startsWith("screening_")) {
        // Голосове, стікер тощо посеред анкети — не відповідь: повертаємо питання.
        const { startScreening } = await import("./handlers/index.js");
        await startScreening(ctx);
        return;
    }

    if (candidate) {
        // Повідомлення пішло в тред HR — кажемо про це, не частіше разу на
        // FORWARDED_ACK_TTL_SECONDS, щоб не встрявати в живу переписку
        // (рішення власника 01.10.2026). HIRED сюди не дзеркалиться — для неї
        // лишається колишній екран статусу.
        if (candidate.status !== "HIRED" && isMirroredCandidateMessage(ctx)) {
            const first = await redis
                .set(`candidate:forwarded-ack:${ctx.from!.id}`, "1", "EX", FORWARDED_ACK_TTL_SECONDS, "NX")
                .catch(() => "OK");
            if (first === "OK") await ctx.reply(CANDIDATE_TEXTS["candidate-message-forwarded"]);
            return;
        }
        // Стікер, кружечок без підпису тощо: до HR не доходить, обіцяти нічого не можна.
        if (candidate.status !== "HIRED") return;

        const { showCandidateStatus } = await import("../../utils/candidate-ui.js");

        await ctx.reply(CANDIDATE_TEXTS["candidate-error-unknown-message"], { parse_mode: "HTML" });
        await showCandidateStatus(ctx, candidate);
        return;
    }

    await next();
});
