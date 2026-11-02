import { InlineKeyboard, type Api } from "grammy";
import { buildSignedCallback } from "../utils/signed-callback.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { redis } from "../core/redis.js";
import { escapeHtml } from "../handlers/admin/utils.js";
import { surnameAndName } from "../utils/person-name.js";
import type { PitchReviewPayload } from "./training-review.js";

export const TRAINING_CB = {
    pass: "tpp",
    retry: "tpr",
    toggle: "tpt",
    sendRetry: "tps",
    reject: "tpj",
    rejectReason: "tpx",
    back: "tpk",
} as const;

export const TRAINING_REJECT_REASONS = ["NOT_A_FIT", "CANDIDATE_DECLINED", "OTHER"] as const;

const CARD_TTL_SECONDS = 14 * 24 * 3600;
export const cardKey = (reviewPublicId: string) => `training:review:card:${reviewPublicId}`;

export function renderReviewCard(p: PitchReviewPayload): string {
    const lines = [
        ADMIN_TEXTS["training-review-title"](escapeHtml(surnameAndName(p.candidateName))),
        "",
        `Location: ${escapeHtml(p.locationName ?? "—")}`,
        `Test score: ${p.scorePct === null ? "—" : `${p.scorePct}%`}`,
        `Attempt ${p.attemptNo}${p.reminder ? " · waiting over 24 h" : ""}`,
        "",
        "Checklist",
        ...p.checklist.map((item, index) => `${index + 1}. ${escapeHtml(item)}`),
    ];
    return lines.join("\n");
}

export function reviewKeyboard(reviewPublicId: string): InlineKeyboard {
    return new InlineKeyboard()
        .text("Passed", buildSignedCallback(TRAINING_CB.pass, reviewPublicId))
        .text("Try again", buildSignedCallback(TRAINING_CB.retry, reviewPublicId))
        .text("Reject", buildSignedCallback(TRAINING_CB.reject, reviewPublicId));
}

export function retryKeyboard(reviewPublicId: string, mask: number, checklist: string[]): InlineKeyboard {
    // Маска из битов: payload кнопки держит до двух цифр (<= 99), то есть не более 6 пунктов.
    if (checklist.length > 6) throw new Error("TRAINING_CHECKLIST_TOO_LONG");
    const kb = new InlineKeyboard();
    checklist.forEach((item, index) => {
        const bit = 1 << index;
        const label = `${mask & bit ? "✗ " : ""}${index + 1}. ${item}`;
        kb.text(label, buildSignedCallback(TRAINING_CB.toggle, `${reviewPublicId}.${mask ^ bit}`)).row();
    });
    return kb
        .text("Send to candidate", buildSignedCallback(TRAINING_CB.sendRetry, `${reviewPublicId}.${mask}`))
        .row()
        .text(ADMIN_TEXTS["training-back"], buildSignedCallback(TRAINING_CB.back, reviewPublicId));
}

export function rejectKeyboard(reviewPublicId: string): InlineKeyboard {
    const kb = new InlineKeyboard();
    TRAINING_REJECT_REASONS.forEach((code, index) => {
        kb.text(
            ADMIN_TEXTS["training-reject-reason"](code),
            buildSignedCallback(TRAINING_CB.rejectReason, `${reviewPublicId}.${index}`),
        ).row();
    });
    return kb.text(ADMIN_TEXTS["training-back"], buildSignedCallback(TRAINING_CB.back, reviewPublicId));
}

const voiceSentKey = (deliveryKey: string) => `training:review:voice-sent:${deliveryKey}`;

/**
 * deliveryKey — publicId команды REQUEST_PITCH_REVIEW. Ретрай той же команды
 * (голосовое ушло, текст карточки — нет) не шлёт голосовое повторно; напоминание
 * через 24 ч — новая команда, и голосовое уходит владельцу снова.
 */
export async function sendReviewCard(
    api: Api,
    chatId: number,
    p: PitchReviewPayload,
    deliveryKey: string,
): Promise<void> {
    // Redis первым (идемпотентная перезапись): иначе при сбое после отправки
    // владелец держит живую карточку, а кнопки не найдут сохранённый чек-лист.
    await redis.set(
        cardKey(p.reviewPublicId),
        JSON.stringify({ checklist: p.checklist, candidateName: p.candidateName }),
        "EX",
        CARD_TTL_SECONDS,
    );
    const sentKey = voiceSentKey(deliveryKey);
    if (!(await redis.get(sentKey))) {
        if (p.attachmentKind === "VOICE") await api.sendVoice(chatId, p.fileId);
        else await api.sendVideoNote(chatId, p.fileId);
        await redis.set(sentKey, "1", "EX", CARD_TTL_SECONDS);
    }
    await api.sendMessage(chatId, renderReviewCard(p), {
        parse_mode: "HTML",
        reply_markup: reviewKeyboard(p.reviewPublicId),
    });
}

/** Разбор `<uuid>.<int>` из payload кнопки. */
export function splitIdAndNumber(payload: string): { reviewPublicId: string; n: number } | null {
    const match = /^([0-9a-f-]{36})\.(\d{1,2})$/u.exec(payload);
    return match?.[1] ? { reviewPublicId: match[1], n: Number(match[2]) } : null;
}
