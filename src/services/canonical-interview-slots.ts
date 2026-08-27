import { AWS_RECRUITING_SLOTS_ENABLED } from "../config.js";
import prisma from "../db/core.js";
import logger from "../core/logger.js";
import { interviewRepository } from "../repositories/interview-repository.js";
import { awsBusinessClient, type RecruitingInterviewSlot } from "./aws-business-client.js";
import { bookingService } from "./booking-service.js";

/**
 * Переключатель канонических слотов интервью (фаза 2b рекрутинговой миграции).
 *
 * Флаг ВЫКЛЮЧЕН: всё как раньше — список из локального репозитория, бронь
 * через bookingService, вебапп не трогается вовсе.
 *
 * Флаг ВКЛЮЧЁН: владелец слотов — вебапп. Список и бронь идут в его API
 * (кнопки несут publicId веб-слота), а после успешной брони пишется
 * ЛОКАЛЬНОЕ зеркало слота и выполняется прежняя локальная логика брони —
 * статус кандидатки, событие в Google Calendar, связь со слотом. На зеркале
 * держатся напоминания 6h/10m/HR и автозавершение, их переезд — фаза 2c.
 *
 * Слоты знакомств и навчання остаются локальными в обоих режимах.
 */

/** Причины освобождения — уходят в releasedReason вебаппа (контракт: ≤120). */
export type CanonicalReleaseReason = "candidate_cancelled" | "candidate_withdrew" | "rescheduled";

/** Минимум, который нужен клавиатуре выбора слота. */
export interface AvailableInterviewSlot {
    id: string;
    startTime: Date;
}

/**
 * Свободные будущие слоты для клавиатуры. Под флагом id кнопки — publicId
 * веб-слота (uuid, 36 символов): callback `book_slot_<uuid>` занимает 46 байт
 * из телеграмного лимита в 64, запас остаётся.
 */
export async function findAvailableInterviewSlots(): Promise<AvailableInterviewSlot[]> {
    if (!AWS_RECRUITING_SLOTS_ENABLED) {
        return interviewRepository.findActiveSlots();
    }
    const { items } = await awsBusinessClient.listRecruitingInterviewSlots();
    return items.map((slot) => ({ id: slot.publicId, startTime: new Date(slot.startsAt) }));
}

/**
 * Бронь слота кандидаткой. Под флагом порядок жёсткий: сначала вебапп
 * (проигрыш гонки — AwsBusinessApiError с кодом RECRUITING_SLOT_TAKEN,
 * локально при этом не пишется НИЧЕГО), затем write-through локального
 * зеркала, затем прежняя локальная бронь со всеми её проверками анкеты,
 * статусом и календарём.
 */
export async function bookInterviewSlot(
    telegramId: number,
    slotId: string,
    username: string | undefined,
) {
    if (!AWS_RECRUITING_SLOTS_ENABLED) {
        return bookingService.bookInterviewSlot(telegramId, slotId, username);
    }
    const booked = await awsBusinessClient.bookRecruitingInterviewSlot(slotId, String(telegramId));
    const mirror = await ensureLocalMirrorSlot(booked);
    return bookingService.bookInterviewSlot(telegramId, mirror.id, username);
}

/**
 * Освобождение брони в вебаппе перед локальной отменой. Выключенный флаг —
 * no-op, поэтому вызовы стоят в хендлерах безусловно и не меняют старый
 * путь ни на байт. Ошибка НЕ глотается: локальная отмена без веб-отмены
 * оставила бы слот занятым для всех остальных кандидаток.
 */
export async function releaseCanonicalInterviewSlot(
    telegramId: number,
    reason: CanonicalReleaseReason,
): Promise<void> {
    if (!AWS_RECRUITING_SLOTS_ENABLED) return;
    await awsBusinessClient.releaseRecruitingInterviewSlot(String(telegramId), reason);
}

/**
 * Write-through: локальная строка InterviewSlot под веб-слот, по одной на
 * publicId (@unique). Сессия создаётся точечно под слот — HR-календарь
 * строится по слотам, отдельного смысла у сессии-обёртки здесь нет.
 *
 * Занятое зеркало при выигранной брони — ложь локального состояния (вебапп
 * только что отдал слот как FREE), например след упавшей ранее отмены:
 * освобождаем и бронируем заново, канон — вебапп.
 */
async function ensureLocalMirrorSlot(slot: RecruitingInterviewSlot) {
    const startTime = new Date(slot.startsAt);
    const endTime = new Date(slot.endsAt);

    const existing = await prisma.interviewSlot.findUnique({
        where: { webSlotPublicId: slot.publicId },
    });
    if (existing === null) {
        const session = await prisma.interviewSession.create({
            data: { startTime, endTime },
        });
        return prisma.interviewSlot.create({
            data: {
                sessionId: session.id,
                startTime,
                endTime,
                webSlotPublicId: slot.publicId,
            },
        });
    }
    if (existing.isBooked) {
        logger.warn(
            { slotId: existing.id, webSlotPublicId: slot.publicId },
            "Local mirror slot was stale-booked while the web slot was free; unbooking the mirror",
        );
        return prisma.interviewSlot.update({
            where: { id: existing.id },
            data: { isBooked: false, candidate: { disconnect: true }, googleEventId: null },
        });
    }
    return existing;
}
