// Сверка сбора пожеланий за месяц: почему человек не подал. ТОЛЬКО ЧТЕНИЕ.
//
// Запускается внутри контейнера бота (playphoto-bot-bot-1): там есть
// DATABASE_URL бота, REDIS_URL его сессий и доступ к API вебаппа. Доставляет
// файл раннер вебаппа (apps/api/scripts/run-delivery-expense-audit.sh) с
// CONTAINER=playphoto-bot-bot-1.
//
// Кого проверять, решает вебапп: `/schedule-preferences/missing` — тот же
// список, по которому бот напоминает. Для каждого из списка:
//
//   1. дошло ли приглашение (BroadcastDelivery рассылки месяца);
//   2. что стало с ожиданием ответа (PendingReply): `confirmed` без подачи —
//      это нажатая «Ознайомлена» на пинге (баг до ef9c794 в боте), потому что
//      успешная подача пишет `confirmed` только ПОСЛЕ записи в вебапп;
//   3. не лежит ли в сессии брошенная форма с выбранными днями (Redis, TTL
//      24 ч, продлевается любым действием в боте) — дни, которые человек
//      выбрал, но не сохранил.
//
// Ничего не пишет: ни в базу, ни в Redis (только HGET/TTL), ни в API (только GET).
//
//   MONTH=2026-10 (по умолчанию — следующий месяц по Киеву)

import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

const MONTHS_UK = [
    "січень", "лютий", "березень", "квітень", "травень", "червень",
    "липень", "серпень", "вересень", "жовтень", "листопад", "грудень",
];

function defaultMonth() {
    const kyiv = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
    const next = new Date(kyiv.getFullYear(), kyiv.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

const MONTH = process.env.MONTH ?? defaultMonth();
const [year, monthNumber] = MONTH.split("-").map(Number);
const monthName = MONTHS_UK[monthNumber - 1];

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 2 });

async function main() {
    // Клиент вебаппа берётся из dist: он уже в образе (код main) и знает адрес
    // и ключ API. Своя копия запроса разошлась бы с ним молча.
    const { awsBusinessClient } = await import("/app/dist/services/aws-business-client.js");
    const missing = await awsBusinessClient.missingSchedulePreferences(MONTH);

    // Рассылка месяца — та, у чьих строк трекинга есть `pingUntil`: его ставит
    // только сбор пожеланий. Окно по дате создания отсекает прошлые месяцы.
    const from = new Date(Date.UTC(year, monthNumber - 2, 15));
    const to = new Date(Date.UTC(year, monthNumber - 1, 1));
    const broadcasts = await prisma.broadcast.findMany({
        where: { createdAt: { gte: from, lt: to }, trackedMessages: { some: { pingUntil: { not: null } } } },
        select: { id: true, createdAt: true, messageText: true },
        orderBy: { createdAt: "asc" },
    });
    const broadcastIds = broadcasts.map((row) => row.id);

    await redis.connect();

    const rows = [];
    for (const item of missing.items) {
        const telegramId = BigInt(item.telegramId);
        const user = await prisma.user.findUnique({
            where: { telegramId },
            select: { firstName: true, lastName: true, username: true, staffProfile: { select: { fullName: true, isActive: true } } },
        });
        const delivery = await prisma.broadcastDelivery.findFirst({
            where: { broadcastId: { in: broadcastIds }, chatId: telegramId },
            select: { status: true, lastError: true, sentAt: true },
            orderBy: { id: "desc" },
        });
        const reply = await prisma.pendingReply.findFirst({
            where: { userId: telegramId, trackedMessage: { broadcastId: { in: broadcastIds } } },
            select: { status: true, respondedAt: true },
            orderBy: { id: "desc" },
        });

        // Личный чат: chatId совпадает с userId (`session:${chatId}:${userId}`).
        const sessionKey = `session:${item.telegramId}:${item.telegramId}`;
        const rawForm = await redis.hget(sessionKey, "preferencesData");
        let form = null;
        if (rawForm) {
            try { form = JSON.parse(rawForm); } catch { form = null; }
        }
        const formForMonth = form && form.month === monthName && Number(form.year) === year ? form : null;
        const sessionTtl = formForMonth ? await redis.ttl(sessionKey) : null;

        let verdict;
        if (!delivery || delivery.status !== "SENT") verdict = "NOT_DELIVERED";
        else if (reply?.status === "confirmed") verdict = "PRESSED_ACKNOWLEDGE";
        else if (reply?.status === "declined") verdict = "PRESSED_DECLINE";
        else verdict = "SILENT";

        rows.push({
            name: user?.staffProfile?.fullName ?? ([user?.firstName, user?.lastName].filter(Boolean).join(" ") || "(нет в базе бота)"),
            telegramId: item.telegramId,
            employeePublicId: item.employeePublicId,
            verdict,
            delivery: delivery ? `${delivery.status}${delivery.lastError ? ` (${delivery.lastError.slice(0, 60)})` : ""}` : "нет доставки",
            reply: reply ? `${reply.status}${reply.respondedAt ? ` ${reply.respondedAt.toISOString().slice(0, 16)}Z` : ""}` : "нет ожидания",
            abandonedForm: formForMonth
                ? { step: formForMonth.step, days: [...(formForMonth.selectedDays ?? [])].sort((a, b) => a - b), comment: formForMonth.comment || "", ttlHours: sessionTtl !== null && sessionTtl > 0 ? Math.round(sessionTtl / 3600) : sessionTtl }
                : null,
        });
    }

    const LABEL = {
        NOT_DELIVERED: "приглашение не дошло",
        PRESSED_ACKNOWLEDGE: "нажала «Ознайомлена» вместо подачи",
        PRESSED_DECLINE: "нажала «Не згодна»",
        SILENT: "получила и молчит",
    };

    console.log(`Сбор пожеланий на ${monthName} ${year} (${MONTH})`);
    console.log(`Рассылки месяца: ${broadcasts.map((row) => `#${row.id} от ${row.createdAt.toISOString().slice(0, 16)}Z «${(row.messageText ?? "").split("\n")[0].slice(0, 40)}»`).join("; ") || "НЕ НАЙДЕНЫ"}`);
    console.log(`Вебапп считает неподавшими (с Telegram): ${missing.items.length}`);
    console.log("");

    for (const key of Object.keys(LABEL)) {
        const group = rows.filter((row) => row.verdict === key);
        console.log(`== ${LABEL[key]}: ${group.length}`);
        for (const row of group) {
            console.log(`  ${row.name} · tg ${row.telegramId} · доставка ${row.delivery} · ответ ${row.reply}`);
            if (row.abandonedForm) {
                const form = row.abandonedForm;
                console.log(`    ↳ брошенная форма (шаг ${form.step}, сессия живёт ещё ~${form.ttlHours} ч): выходные ${form.days.join(", ") || "нет (готова в любой день)"}${form.comment ? `; комментарий «${form.comment}»` : ""}`);
            }
        }
        console.log("");
    }

    const withForm = rows.filter((row) => row.abandonedForm).length;
    console.log(`Итого: ${rows.length} неподавших; с брошенной формой в сессии: ${withForm}.`);
    console.log("JSON:");
    console.log(JSON.stringify(rows));
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
        redis.disconnect();
        // Клиент вебаппа и логгер держат таймеры — без явного выхода процесс висит.
        setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
    });
