import { InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import { CandidateStatus } from "@prisma/client";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { HR_IDS } from "../config.js";
import logger from "../core/logger.js";

export function isBotBlocked(err: any): boolean {
    const desc = err?.description || err?.message || "";
    return desc.includes("bot was blocked") ||
        desc.includes("user is deactivated") ||
        desc.includes("chat not found") ||
        err?.error_code === 403;
}

export async function handleBlockedCandidate(
    api: Api,
    candidateId: string,
    candidateName: string,
) {
    await candidateRepository.update(candidateId, {
        status: CandidateStatus.REJECTED,
        candidateDecision: "Бот заблоковано / акаунт видалено"
    });

    const hrId = HR_IDS[0];
    if (hrId) {
        const text = `⚠️ <b>Bot Blocked</b>\n\n` +
            `👤 <b>${candidateName}</b> заблокувала бот.\n` +
            `Статус → <b>REJECTED</b> автоматично.`;
        const kb = new InlineKeyboard().text("👤 View Profile", `view_candidate_${candidateId}`);
        await api.sendMessage(hrId, text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    }

    logger.info({ candidateId }, "🚫 Candidate auto-rejected: bot blocked/account deleted.");
}
