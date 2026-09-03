import type { RecruitingCandidateSnapshot } from "../aws-business-client.js";

/**
 * Минимальная структурная форма строки кандидата с релейшенами, которая нужна
 * снимку. Структурный тип вместо `CandidateWithRelations` — чистой функции не
 * нужны messages/слоты, и тесты собирают строку руками без Prisma.
 */
export interface MirrorCandidateRow {
    id: string;
    fullName?: string | null;
    phone?: string | null;
    gender?: string | null;
    /**
     * В схеме Prisma это DateTime, но исторические строки могли приехать из
     * листа строкой "ДД.ММ.РРРР" — принимаем обе формы, непригодное → null.
     */
    birthDate?: Date | string | null;
    city?: string | null;
    source?: string | null;
    status: string;
    hrDecision?: string | null;
    lossStage?: string | null;
    lossReason?: string | null;
    statusChangedAt?: Date | string | null;
    pipelineTouchedAt?: Date | string | null;
    tattooPhotoId?: string | null;
    user: {
        telegramId: bigint | number | string;
        username?: string | null;
        createdAt?: Date | string | null;
    };
    location?: { canonicalCode?: string | null } | null;
    interviewSlot?: { startTime?: Date | string | null } | null;
    noSlotsAt?: Date | string | null;
}

/** Дата-время → строгая ISO-строка; всё невалидное → null. */
function toIsoDateTime(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Дата рождения → 'YYYY-MM-DD'.
 *
 * Date берётся по UTC-компонентам — так же, как её читает findBirthdaysToday.
 * Строка "ДД.ММ.РРРР" разбирается с проверкой круговой сходимости: 31.02.2000
 * без неё молча превратился бы во 2 марта вместо честного null.
 */
function toIsoBirthDate(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value.trim());
    if (!match) return null;
    const [, dd, mm, yyyy] = match;
    const day = Number(dd);
    const month = Number(mm);
    const year = Number(yyyy);
    const date = new Date(Date.UTC(year, month - 1, day));
    const roundTrips =
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
    return roundTrips ? date.toISOString().slice(0, 10) : null;
}

/** Приёмная сторона принимает только 'female'/'male' — всё прочее null. */
function normalizeGender(value: string | null | undefined): "female" | "male" | null {
    return value === "female" || value === "male" ? value : null;
}

/**
 * Чистая функция: строка кандидата с релейшенами → wire-снимок для
 * POST /internal/bot/recruiting/candidates. `botStatus` уходит сырым —
 * зеркало обязано переживать релиз бота с новым статусом.
 */
export function buildCandidateMirrorSnapshot(candidate: MirrorCandidateRow): RecruitingCandidateSnapshot {
    return {
        telegramId: String(candidate.user.telegramId),
        botCandidateId: candidate.id,
        telegramUsername: candidate.user.username ?? null,
        fullName: candidate.fullName ?? null,
        phone: candidate.phone ?? null,
        gender: normalizeGender(candidate.gender),
        birthDate: toIsoBirthDate(candidate.birthDate),
        city: candidate.city ?? null,
        locationCode: candidate.location?.canonicalCode ?? null,
        source: candidate.source ?? null,
        botStatus: candidate.status,
        hrDecision: candidate.hrDecision ?? null,
        lossStage: candidate.lossStage ?? null,
        lossReason: candidate.lossReason ?? null,
        interviewAt: toIsoDateTime(candidate.interviewSlot?.startTime),
        statusChangedAt: toIsoDateTime(candidate.statusChangedAt),
        lastActivityAt: toIsoDateTime(candidate.pipelineTouchedAt),
        botCreatedAt: toIsoDateTime(candidate.user.createdAt),
        tattooPhotoFileId: candidate.tattooPhotoId ?? null,
        noSlotsAt: toIsoDateTime(candidate.noSlotsAt),
    };
}
