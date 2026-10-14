import { z } from "zod";

/**
 * Данные, которые вебапп кладёт в RecruitingCommand.payload для обучения кандидаток
 * (спека 2026-10-13-candidate-online-training-design.md). Бот — транспорт: читает,
 * не решает. Неизвестное значение = старое поведение, чтобы новый вебапп не ломал старый бот
 * и наоборот.
 */
export const pitchReviewPayloadSchema = z.object({
    reviewPublicId: z.string().uuid(),
    fileId: z.string().min(1),
    attachmentKind: z.enum(["VOICE", "VIDEO_NOTE"]),
    candidateName: z.string(),
    locationName: z.string().nullable(),
    scorePct: z.number().int().nullable(),
    attemptNo: z.number().int().min(1),
    checklist: z.array(z.string()).max(6),
    reminder: z.boolean(),
});
export type PitchReviewPayload = z.infer<typeof pitchReviewPayloadSchema>;

export function parsePitchReviewPayload(payload: unknown): PitchReviewPayload {
    return pitchReviewPayloadSchema.parse(payload);
}

export function readTrainingMode(payload: Record<string, unknown> | null): "MINIAPP" | "OWNER" {
    return payload?.trainingMode === "MINIAPP" ? "MINIAPP" : "OWNER";
}

export function readCandidateMessage(payload: Record<string, unknown> | null): "TRAINING_REJECTED" | null {
    return payload?.candidateMessage === "TRAINING_REJECTED" ? "TRAINING_REJECTED" : null;
}

/** База без хвостовых «/» + путь ровно с одним ведущим «/», как бы их ни прислали. */
export function buildMiniAppUrl(base: string | undefined, path: string): string {
    if (!base) throw new Error("OFFER_NOT_SENT:miniapp_url_missing");
    return `${base.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}
