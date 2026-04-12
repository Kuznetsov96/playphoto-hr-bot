import type { Api } from "grammy";
import { CandidateStatus } from "@prisma/client";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { HR_IDS } from "../config.js";
import logger from "../core/logger.js";

export const BLOCKED_CANDIDATE_DECISION = "Бот заблоковано / контакт призупинено";

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
    const candidate = await candidateRepository.findById(candidateId);
    if (!candidate) return;

    if (candidate.status === CandidateStatus.BLOCKER && candidate.user?.botBlockedAt) {
        return;
    }

    await candidateRepository.archiveBlockedCandidate(candidateId, BLOCKED_CANDIDATE_DECISION);

    const hrId = HR_IDS[0];
    if (hrId) {
        const text = `⚠️ <b>Bot Blocked</b>\n👤 <b>${candidateName}</b> — статус <b>BLOCKER</b> автоматично. Контакт зупинено, профіль збережено.`;
        await api.sendMessage(hrId, text, { parse_mode: "HTML" }).catch(() => { });
    }

    logger.info({ candidateId }, "🚫 Candidate archived as BLOCKER after bot block.");
}
