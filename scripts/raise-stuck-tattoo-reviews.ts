/**
 * Разовая операция: поднять на ревью анкеты с фото тату, осевшие в WAITLIST_HR.
 *
 * Причина: повышение в MANUAL_REVIEW было вложено в ветку `status ===
 * SCREENING`, поэтому кандидатка, выбравшая укомплектованную локацию
 * (`neededCount = 0`), уходила в очередь ожидания вместе со своим фото — и
 * его не видел никто, хотя бот пообещал ей «HR-менеджер скоро напише тобі
 * тут». На 03.09.2026 в проде так осело 16 анкет при трёх реально стоящих
 * на ревью.
 *
 * ЗАПУСКАТЬ ТОЛЬКО ПОСЛЕ ВЫКАТА ИСПРАВЛЕНИЯ (resolveScreeningStatus),
 * иначе следующая запись кандидатки вернёт статус обратно.
 *
 * Сухой прогон по умолчанию; применение — APPLY=true.
 */
import { CandidateStatus } from "@prisma/client";

import prisma from "../db/core.js";

const APPLY = process.env.APPLY === "true";

async function main(): Promise<void> {
    const stuck = await prisma.candidate.findMany({
        where: {
            status: CandidateStatus.WAITLIST_HR,
            tattooPhotoId: { not: null },
        },
        select: {
            id: true,
            fullName: true,
            city: true,
            statusChangedAt: true,
            pipelineTouchedAt: true,
            tattooPhotoId: true,
        },
        // У Candidate нет createdAt: возраст и порядок считаем по последнему
        // касанию воронки — самые давние сверху.
        orderBy: { pipelineTouchedAt: "asc" },
    });

    console.log(`Анкет с фото тату в WAITLIST_HR: ${stuck.length}`);
    for (const candidate of stuck) {
        const waitingSince = candidate.statusChangedAt ?? candidate.pipelineTouchedAt;
        const days = Math.floor((Date.now() - waitingSince.getTime()) / 86_400_000);
        console.log(
            `  ${candidate.id}  ${candidate.fullName ?? "—"}  ${candidate.city ?? "—"}  ждёт ${days} дн.`,
        );
    }

    if (stuck.length === 0) {
        console.log("Поднимать нечего.");
        return;
    }

    if (!APPLY) {
        console.log("\nСухой прогон. Для применения: APPLY=true");
        return;
    }

    // Статус меняем по одному и с явным условием: параллельный пуш бота мог
    // увести кандидатку дальше по воронке, пока скрипт печатал список, и
    // затирать чужой прогресс нельзя.
    let raised = 0;
    for (const candidate of stuck) {
        const { count } = await prisma.candidate.updateMany({
            where: { id: candidate.id, status: CandidateStatus.WAITLIST_HR },
            data: {
                status: CandidateStatus.MANUAL_REVIEW,
                isWaitlisted: false,
                statusChangedAt: new Date(),
            },
        });
        raised += count;
    }
    console.log(`\nПоднято на ревью: ${raised} из ${stuck.length}`);
}

main()
    .catch((error: unknown) => {
        console.error("Не удалось поднять анкеты:", error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
