/**
 * Перевірка перед звуженням доступу до закритого каналу.
 *
 * Право на канал тепер мають лише Role.STAFF з активним профілем і кандидатки
 * зі статусом HIRED (див. AccessService.isAuthorized). Раніше його давали 13
 * статусів, тож у каналі могли осісти люди, які до команди не дійшли.
 *
 * Скрипт нічого не змінює — тільки читає й показує, кого зачепить наступна
 * звірка. Найважливіший блок — перший: працівники, у яких роль чомусь лишилася
 * CANDIDATE. Саме вони втратили б доступ помилково, і їх треба полагодити
 * ДО деплою.
 *
 * Запуск з кореня репозиторію (де лежить .env):
 *   npx tsx scripts/check-channel-access.ts
 * Запуск усередині прод-контейнера (вихідників src там немає, лише dist;
 * DATABASE_URL вказує на сусідній контейнер postgres, тож ззовні база
 * недоступна — саме тому перевірку треба робити на сервері):
 *   docker exec playphoto-bot-bot-1 npx tsx /app/scripts/check-channel-access.ts
 */
import { PrismaClient, Role, CandidateStatus } from "@prisma/client";

const prisma = new PrismaClient();

/** Статуси, які давали доступ раніше, але більше не дають. */
const REVOKED_STATUSES: CandidateStatus[] = [
    CandidateStatus.ACCEPTED,
    CandidateStatus.MENTOR_MANUAL,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
];

async function main() {
    console.log("\n=== Перевірка доступу до закритого каналу ===\n");

    /**
     * 1. НЕБЕЗПЕЧНІ: працює, але роль лишилася CANDIDATE.
     *
     * Такі люди проходили доступ за статусом кандидатки, а після звуження
     * пройдуть тільки якщо статус саме HIRED. Активний staffProfile означає,
     * що людина працює, тож втратити доступ вона не має.
     */
    const workingButCandidate = await prisma.user.findMany({
        where: {
            role: Role.CANDIDATE,
            staffProfile: { isActive: true },
        },
        select: {
            telegramId: true,
            firstName: true,
            candidate: { select: { fullName: true, status: true } },
            staffProfile: { select: { fullName: true, isActive: true } },
        },
    });

    const willBreak = workingButCandidate.filter(
        (u) => u.candidate?.status !== CandidateStatus.HIRED,
    );

    if (willBreak.length === 0) {
        console.log("✅ Працівників із роллю CANDIDATE, що втратять доступ, немає.\n");
    } else {
        console.log(`🚨 УВАГА: ${willBreak.length} прац. втратять доступ помилково!\n`);
        for (const u of willBreak) {
            const name = u.staffProfile?.fullName || u.candidate?.fullName || u.firstName || "—";
            console.log(`   telegramId=${u.telegramId}  ${name}  статус=${u.candidate?.status ?? "—"}`);
        }
        console.log("\n   Полагодити ДО деплою: цим користувачам треба роль STAFF.");
        console.log('   UPDATE "User" SET role = \'STAFF\' WHERE "telegramId" IN (...);\n');
    }

    /** 2. Кандидатки, які доступ втратять — і це очікувано. */
    const losingAccess = await prisma.candidate.count({
        where: {
            status: { in: REVOKED_STATUSES },
            user: { role: Role.CANDIDATE },
        },
    });
    console.log(`ℹ️  Кандидаток, які втратять доступ (очікувано): ${losingAccess}`);

    const byStatus = await prisma.candidate.groupBy({
        by: ["status"],
        where: {
            status: { in: REVOKED_STATUSES },
            user: { role: Role.CANDIDATE },
        },
        _count: { _all: true },
    });
    for (const row of byStatus.sort((a, b) => b._count._all - a._count._all)) {
        console.log(`      ${row.status.padEnd(22)} ${row._count._all}`);
    }

    /** 3. Хто доступ збереже. */
    const activeStaff = await prisma.staffProfile.count({ where: { isActive: true } });
    const hiredCandidates = await prisma.candidate.count({
        where: { status: CandidateStatus.HIRED, user: { role: Role.CANDIDATE } },
    });
    console.log(`\n✅ Збережуть доступ:`);
    console.log(`      активні співробітниці (STAFF)  ${activeStaff}`);
    console.log(`      кандидатки у статусі HIRED     ${hiredCandidates}`);

    console.log(
        willBreak.length === 0
            ? "\n=== Можна деплоїти ===\n"
            : "\n=== НЕ деплоїти, доки не полагоджені ролі вище ===\n",
    );

    await prisma.$disconnect();
    process.exit(willBreak.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error("Помилка:", e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(2);
});
