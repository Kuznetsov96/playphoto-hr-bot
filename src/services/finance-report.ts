import { techCashService } from "./finance/tech-cash.js";
import { Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import { FINANCE_IDS, FOP_DISPLAY_NAMES, FOP_WALLET_CODES } from "../config.js";
import { locationRepository } from "../repositories/location-repository.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { getReportableCashAmount, shouldExcludeTerminalFromFopAccounting } from "./finance/location-rules.js";
import { awsBusinessClient, type DailySummary } from "./aws-business-client.js";
import { renderDailySummary } from "./finance/daily-summary-message.js";

/** Сегодняшняя дата в Киеве как `YYYY-MM-DD`. */
function kyivIsoDate(instant: Date): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Kyiv",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find(candidate => candidate.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Вечерняя сводка выручки.
 *
 * Источник — вебапп, а не Google Sheets: все локации закрывают смены в
 * приложении, а лист перестаёт наполняться после переезда локации. Пока отчёт
 * читал лист, переехавшая локация выпадала из выручки и попадала в «нет
 * данных» — то есть выглядела как невыход, хотя смену там закрыли.
 *
 * Сообщение уходит даже когда сводку получить не удалось: тишина в 21:40
 * читается как «день пустой», а не как «отчёт сломался».
 */
export async function sendDailyIncomeReport(bot: Bot<MyContext>, chatId?: number, forceSync: boolean = false) {
    try {
        const todayStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }); // DD.MM.YYYY
        const todayIso = kyivIsoDate(new Date());
        logBusinessEvent({
            event: "finance.daily_income_report.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "finance-report",
            operation: "sendDailyIncomeReport",
            safeContext: {
                reportDate: todayStr,
                forcedSync: forceSync,
                targetChatId: chatId || null,
            },
        });

        let summary: DailySummary | null = null;
        try {
            summary = await awsBusinessClient.dailySummary();
        } catch (error) {
            logger.error({ err: error }, "Daily summary fetch failed");
            logBusinessEvent({
                event: "finance.daily_income_report.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "SUMMARY_UNAVAILABLE",
                module: "finance-report",
                operation: "sendDailyIncomeReport",
                safeContext: { reportDate: todayStr },
            });
        }

        const reportText = renderDailySummary(summary, todayIso);

        // Send to Finance Administrators
        const RECIPIENTS = chatId ? [chatId] : FINANCE_IDS;

        for (const adminId of RECIPIENTS) {
            try {
                await bot.api.sendMessage(adminId, reportText, { parse_mode: "HTML" });
            } catch (e) {
                logger.error({ err: e }, `Failed to send report to ${adminId}`);
            }
        }

        logBusinessEvent({
            event: "finance.daily_income_report.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "finance-report",
            operation: "sendDailyIncomeReport",
            safeContext: {
                reportDate: todayStr,
                locationCount: summary?.locations.length ?? 0,
                overdueCount: summary?.overdue.length ?? 0,
                neverOpenedCount: summary?.neverOpened.length ?? 0,
                summaryAvailable: summary !== null,
                recipientCount: RECIPIENTS.length,
            },
        });

    } catch (e) {
        logger.error({ err: e }, "Finance daily income report generation failed");
        logBusinessEvent({
            event: "finance.daily_income_report.completed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            module: "finance-report",
            operation: "sendDailyIncomeReport",
            error: e,
        });
    }
}

const DDS_ARTICLE_MAPPING: Record<string, string> = {
    "cmlqcgvuu0003la3dnw6jo707": "Выручка от продаж Leolend",
    "cmlqcgvv80005la3djk5w7dqc": "Выручка от продаж Dragon Park",
    "cmlqcgvv20004la3dfz847jdx": "Выручка от продаж Drive City",
    "cmlqcgvwt000bla3dw4lbfpvd": "Выручка от продаж Каремель Коломия",
    "cmlqcgvy4000cla3d1h4n5gua": "Выручка от продаж Каремель Шептицкий",
    "cmlqcgvu40000la3dpbedykxr": "Выручка от продаж Smile Park Київ",
    "cmlqcgvvg0006la3dz89dcti6": "Выручка от продаж Fly Kids (Патона)",
    "cmlqcgvvt0008la3dmgya8w8w": "Выручка от продаж Volkland",
    "cmlqcgvue0001la3dmy7o74nl": "Выручка от продаж Smile Park Київ (Даринок)",
    "cmlqcgvul0002la3de97zrinm": "Выручка от продаж Fly Kids Киев",
    "cmlqcgvya000dla3d7b77q0wv": "Выручка от продаж Fly Kids Ровно",
    "cmlqcgvyf000ela3d66w3ynjd": "Выручка Fantasy Town Черкассы",
    "cmlqcgvym000fla3dlx0v9nrc": "Выручка от продаж Smile Park Kharkiv",
    "cmlqcgvwf0009la3dk9grw586": "Выручка от продаж Volkland 2",
    "cmlqcgvwo000ala3d60mtpkg4": "Выручка от продаж Volkland 3",
    "cmlqcgvvn0007la3dpmt4dgh6": "Выручка от продаж Smile Park Lviv",
    "cmlqcgvys000gla3d92ruth2t": "Выручка от продаж Karamel Sambir",
    "cmlqcgvyx000hla3d1cncpb0u": "Выручка от продаж Dytyache Horyshche",
    // Без явной записи имя статьи собирается как `Выручка от продаж ${name} ${city}`,
    // а город у этой локации записан латиницей — выходит «Kidlandia Kyiv», статьи
    // с таким названием в ДДС нет. В листе это терпимо: там колонка свободная. При
    // проводке через API (FINANCE_DDS_TARGET=api) выручка Kidlandia просто не
    // прошла бы с TREASURY_ARTICLE_NOT_FOUND, и потеря была бы тихой.
    "kidlandia_kyiv": "Выручка от продаж Kidlandia Київ"
};

export function calculateCashSalaryDeduction(income: { totalSalary?: number; photographers?: string[] }): number {
    const perPersonSalary = income.totalSalary || 0;
    const staffCount = Math.max(income.photographers?.length || 0, 1);
    return perPersonSalary * staffCount;
}

/**
 * syncToDDS (автопроводка виручки з таблиці TechCash у ДДС) прибрано
 * 10.09.2026 разом з усім контуром ДДС — рішення власника.
 *
 * Вечірній звіт про доходи лишається: він читає зведення вебзастосунку
 * і в жодні таблиці нічого не пише.
 */

/**
 * sendMorningAuditReport прибрано 10.09.2026 рішенням власника разом з усім
 * модулем фінансової реконсиляції (звірка TechCash / Monobank / ДДС).
 *
 * Вечірній звіт про доходи (sendDailyIncomeReport) лишається — його прибирати
 * не просили.
 */

import { reportsQueue } from "../core/queue.js";

export async function startDailyReportLoop(_bot: Bot<MyContext>) {
    logBusinessEvent({
        event: "finance.report_loop.started",
        actorType: "system",
        actorRole: "system",
        result: "success",
        module: "finance-report",
        operation: "startDailyReportLoop",
    });

    const enqueueDueReports = async () => {
        const now = new Date();
        const kievTime = now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" });
        const localDate = new Date(kievTime);
        const todayKey = [
            localDate.getFullYear(),
            String(localDate.getMonth() + 1).padStart(2, "0"),
            String(localDate.getDate()).padStart(2, "0"),
        ].join("-");
        const minuteOfDay = localDate.getHours() * 60 + localDate.getMinutes();

        try {
            // Stable BullMQ job IDs provide cross-process deduplication and allow a
            // delayed startup to catch up any time after the intended schedule.
            //
            // Ранкова звірка (`send-morning-audit` о 08:00) прибрана 10.09.2026
            // разом з усім модулем реконсиляції — лишився тільки вечірній звіт
            // про доходи.
            if (minuteOfDay >= 21 * 60 + 40) {
                await reportsQueue.add("send-daily-income", { chatId: null }, {
                    jobId: `finance-income-${todayKey}`,
                    attempts: 3,
                    backoff: { type: "exponential", delay: 10_000 },
                });
            }
        } catch (error) {
            logger.error({ err: error, reportDate: todayKey }, "Failed to enqueue scheduled finance report");
        }
    };

    await enqueueDueReports();
    return setInterval(() => {
        enqueueDueReports().catch(error => {
            logger.error({ err: error }, "Finance report scheduler tick failed");
        });
    }, 60 * 1000);
}
