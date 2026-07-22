import { techCashService } from "./finance/tech-cash.js";
import { ddsService } from "./finance/dds.js";
import { Bot, InlineKeyboard } from "grammy";
import type { MyContext } from "../types/context.js";
import { FINANCE_IDS, FOP_DISPLAY_NAMES } from "../config.js";
import { locationRepository } from "../repositories/location-repository.js";
import { monobankService } from "./finance/monobank.js";
import logger from "../core/logger.js";
import { logBusinessEvent } from "../core/log-events.js";
import { getReportableCashAmount, shouldExcludeTerminalFromFopAccounting } from "./finance/location-rules.js";

const CITY_ALIASES: Record<string, string[]> = {
    "Київ": ["київ", "kyiv", "kiev"],
    "Львів": ["львів", "lviv"],
    "Харків": ["харків", "kharkiv"],
    "Рівне": ["рівне", "рівно", "rivne", "rovno"],
    "Запоріжжя": ["запоріжжя", "zaporizhzhia", "zaporizhia"],
    "Черкаси": ["черкаси", "cherkasy"],
    "Хмельницький": ["хмельницький", "khmelnytskyi"],
    "Самбір": ["самбір", "sambir"],
    "Коломия": ["коломия", "коломія", "kolomyya", "kolomyia"],
    "Шептицький": ["шептицький", "sheptytskyi"],
};

function normalizeLocationPart(value: string): string {
    return value
        .normalize("NFC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function formatFinanceLocationLabel(name: string, city: string): string {
    const cleanName = name.trim();
    const cleanCity = city.trim();
    if (!cleanCity) return cleanName;

    const normalizedName = normalizeLocationPart(cleanName);
    const normalizedCity = normalizeLocationPart(cleanCity);
    const cityAliases = CITY_ALIASES[cleanCity] || [normalizedCity];

    if (cityAliases.some(alias => normalizedName.split(" ").includes(alias))) {
        return cleanName;
    }

    return `${cleanName} (${cleanCity})`;
}

// Export for manual testing via command
export async function sendDailyIncomeReport(bot: Bot<MyContext>, chatId?: number, forceSync: boolean = false) {
    try {
        const todayStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }); // DD.MM.YYYY
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

        const incomes = await techCashService.getIncomeForDate(todayStr);

        if (!incomes || incomes.length === 0) {
            logBusinessEvent({
                event: "finance.daily_income_report.completed",
                level: "warn",
                actorType: "system",
                actorRole: "system",
                result: "empty",
                reasonCode: "NO_INCOME_DATA",
                module: "finance-report",
                operation: "sendDailyIncomeReport",
                safeContext: {
                    reportDate: todayStr,
                },
            });
            if (chatId) await bot.api.sendMessage(chatId, `⚠️ No data found for report on ${todayStr}.`);
            return;
        }

        const allLocations = await locationRepository.findAllActive();

        const reportRows = incomes
            .map(inc => {
                const displayedIncome = inc.totalCash + inc.totalTerminal;

                return {
                    ...inc,
                    displayedIncome,
                    label: formatFinanceLocationLabel(inc.locationName, inc.city)
                };
            })
            .sort((a, b) => b.displayedIncome - a.displayedIncome);

        let totalCash = 0;
        let totalTerminal = 0;
        let totalIncome = 0;

        let reportText = `📊 <b>REPORT FOR ${todayStr}</b>\n\n`;

        reportRows.forEach(inc => {
            reportText += `📍 ${inc.label}: <b>${inc.displayedIncome.toLocaleString()} грн</b>\n`;

            totalCash += inc.totalCash;
            totalTerminal += inc.totalTerminal;
            totalIncome += inc.displayedIncome;
        });

        reportText += `--------------------------\n`;
        reportText += `💰 <b>NETWORK TOTALS:</b>\n`;
        reportText += `💵 Cash: ${totalCash.toLocaleString()} UAH\n`;
        reportText += `💳 Terminal: ${totalTerminal.toLocaleString()} UAH\n`;
        reportText += `🔥 <b>TOTAL: ${totalIncome.toLocaleString()} UAH</b>`;

        // Calculate missing locations
        const reportKeys = new Set(incomes.map(inc => `${inc.locationName}|${inc.city}`));
        const missingLocations = allLocations
            .filter(l => !reportKeys.has(`${l.name}|${l.city}`))
            .map(l => formatFinanceLocationLabel(l.name, l.city));

        if (missingLocations.length > 0) {
            reportText += `\n\n⚠️ <b>Missing Data:</b>\n`;
            missingLocations.forEach(name => reportText += `- ${name}\n`);
        }

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
                locationCount: incomes.length,
                recipientCount: RECIPIENTS.length,
            },
        });

        // AUTO-SYNC TO DDS
        // Only if running automatically (no chatId specified) or explicitly requested
        if (!chatId || forceSync) {
            await syncToDDS(todayStr, incomes);
        }

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
    "cmlqcgvyx000hla3d1cncpb0u": "Выручка от продаж Dytyache Horyshche"
};

export function calculateCashSalaryDeduction(income: { totalSalary?: number; photographers?: string[] }): number {
    const perPersonSalary = income.totalSalary || 0;
    const staffCount = Math.max(income.photographers?.length || 0, 1);
    return perPersonSalary * staffCount;
}

export async function syncToDDS(dateStr: string, incomes?: any[], dryRun: boolean = false) {
    try {
        if (!incomes) {
            incomes = await techCashService.getIncomeForDate(dateStr);
        }
        if (!incomes || incomes.length === 0) return { success: false, message: "No data" };

        const allLocations = await locationRepository.findAllActive();
        const locationMap = new Map(allLocations.map(l => [l.id, l]));

        let addedCount = 0;
        let log = "";
        logBusinessEvent({
            event: "finance.dds_sync.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "finance-report",
            operation: "syncToDDS",
            safeContext: {
                date: dateStr,
                dryRun,
                providedIncomeCount: incomes?.length || 0,
            },
        });

        // Pre-fetch DDS sheet ONCE instead of per-location (was 36 reads → 1)
        const existingDds = dryRun ? [] : await ddsService.getTransactionsForDates([dateStr]);

        for (const inc of incomes) {
            try {
                let wroteThisIteration = false;
                const loc = locationMap.get(inc.locationId);
                // Fallback FOPs if location not found (should not happen usually)
                const fopTerminalId = loc?.fopId || "KUZNETSOV";
                const fopCashId = "KUZNETSOV"; // Always Kuznetsov for cash unless specific override needed

                const fopTerminalName = FOP_DISPLAY_NAMES[fopTerminalId] || FOP_DISPLAY_NAMES["KUZNETSOV"] || "Счёт ФОП Кузнецов";
                const fopCashName = FOP_DISPLAY_NAMES[fopCashId] || "Счёт ФОП Кузнецов";

                const salary = calculateCashSalaryDeduction(inc);
                const reportableCash = getReportableCashAmount(inc.totalCash, loc);
                const netCash = Math.max(0, Number((reportableCash - salary).toFixed(2)));

                // Article Name (Category/Comment)
                const baseName = loc?.name || inc.locationName;
                const cityName = loc?.city || "";
                // Avoid double city if name already contains it (simple check)
                const fullName = baseName.toLowerCase().includes(cityName.toLowerCase()) ? baseName : `${baseName} ${cityName}`;

                // 📍 CUSTOM MAPPING for Column I
                const articleName = (loc && DDS_ARTICLE_MAPPING[loc.id]) ||
                    DDS_ARTICLE_MAPPING[inc.locationName] ||
                    `Выручка от продаж ${fullName}`;

                if (loc?.cashInEnvelope) {
                    if (dryRun) log += `[SKIP] Cash for ${fullName} (CashInEnvelope)\n`;
                    else logger.debug({ location: fullName }, "Finance DDS sync skipped cash-in-envelope location");
                } else if (netCash > 0) {
                    const locationLabel = `${fullName} (Готівка)`;
                    const exists = dryRun ? false : ddsService.matchTransaction(existingDds, netCash, locationLabel, dateStr);

                    if (exists) {
                        if (dryRun) log += `[SKIP] Cash for ${fullName} - already in DDS\n`;
                        else logger.debug(`[SKIP] Cash for ${fullName} - already in DDS`);
                    } else if (dryRun) {
                        log += `[DRY] Add Cash: ${netCash} | FOP: ${fopCashName} | ${locationLabel} | Cat: ${articleName}\n`;
                    } else {
                        logger.debug({ location: fullName, amount: netCash, flow: "cash" }, "Finance DDS sync inserting transaction");
                        await ddsService.addTransaction({
                            date: dateStr,
                            amount: netCash,
                            fop: fopCashName,
                            category: articleName,
                            comment: articleName,
                            location: locationLabel
                        });
                        addedCount++;
                        wroteThisIteration = true;
                    }
                }

                // Add Terminal Transaction
                const terminalExcluded = shouldExcludeTerminalFromFopAccounting(loc);
                if (terminalExcluded) {
                    if (dryRun) log += `[SKIP] Terminal for ${fullName} - excluded from FOP accounting\n`;
                    else logger.debug({ location: fullName, amount: inc.totalTerminal }, "Finance DDS sync skipped terminal excluded from FOP accounting");
                } else if (inc.totalTerminal > 0) {
                    // Apply acquiring fee if enabled (1.3%)
                    const feeRate = loc?.hasAcquiring ? 0.013 : 0;
                    const netTerminal = Number((inc.totalTerminal * (1 - feeRate)).toFixed(2));

                    if (netTerminal > 0) {
                        const locationLabel = `${fullName} (Термінал)`;
                        const exists = dryRun ? false : ddsService.matchTransaction(existingDds, netTerminal, locationLabel, dateStr);

                        if (exists) {
                            if (dryRun) log += `[SKIP] Terminal for ${fullName} - already in DDS\n`;
                            else logger.debug(`[SKIP] Terminal for ${fullName} - already in DDS`);
                        } else if (dryRun) {
                            log += `[DRY] Add Terminal: ${netTerminal} (Origin: ${inc.totalTerminal}) | FOP: ${fopTerminalName} | ${locationLabel} | Cat: ${articleName}\n`;
                        } else {
                            logger.debug({ location: fullName, amount: netTerminal, flow: "terminal" }, "Finance DDS sync inserting transaction");
                            await ddsService.addTransaction({
                                date: dateStr,
                                amount: netTerminal,
                                fop: fopTerminalName,
                                category: articleName,
                                comment: articleName,
                                location: locationLabel
                            });
                            addedCount++;
                            wroteThisIteration = true;
                        }
                    }
                }

                // Rate Limit Protection (Google Sheets: 60 writes/min)
                // Only sleep after actual writes, skip for no-ops
                if (!dryRun && wroteThisIteration) await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (e: any) {
                logger.error({ err: e, location: inc.locationName }, "Finance DDS sync failed for location");
                // Continue to next location
            }
        }

        if (dryRun) return { success: true, message: log || "No movements" };
        logBusinessEvent({
            event: "finance.dds_sync.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "finance-report",
            operation: "syncToDDS",
            safeContext: {
                date: dateStr,
                addedCount,
                dryRun,
            },
        });
        return { success: true, message: `Added ${addedCount} records` };
    } catch (e: any) {
        logger.error({ err: e, date: dateStr, dryRun }, "Finance DDS sync failed");
        logBusinessEvent({
            event: "finance.dds_sync.completed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            module: "finance-report",
            operation: "syncToDDS",
            safeContext: {
                date: dateStr,
                dryRun,
            },
            error: e,
        });
        return { success: false, message: e.message };
    }
}


export async function sendMorningAuditReport(bot: Bot<MyContext>, date: Date) {
    try {
        const dateStr = date.toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });
        logBusinessEvent({
            event: "finance.morning_audit_report.started",
            actorType: "system",
            actorRole: "system",
            result: "started",
            module: "finance-report",
            operation: "sendMorningAuditReport",
            safeContext: {
                reportDate: dateStr,
            },
        });
        const incomes = await techCashService.getIncomeForDate(dateStr);

        // 0. Pre-warm Monobank caches in parallel with DDS sync
        const preWarmPromise = monobankService.preWarmForAudit(date).catch(e =>
            logger.warn({ err: e, reportDate: dateStr }, "Finance audit pre-warm failed; using on-demand fetch")
        );

        // 1. "Catch-up" Sync: Ensure late-night reports from yesterday are in DDS
        await syncToDDS(dateStr, incomes).catch(e => logger.error({ err: e, reportDate: dateStr }, "Finance catch-up DDS sync failed"));

        // Wait for pre-warm to finish (likely already done while DDS sync was running)
        await preWarmPromise;

        // 2. Run Audit
        const { reconciliationService } = await import("./finance/reconciliation-service.js");
        const res = await reconciliationService.runReconciliation(dateStr, undefined, undefined, incomes);

        if (!res.success) {
            logger.error({ reportDate: dateStr, message: res.message }, "Finance morning audit reconciliation failed");
            logBusinessEvent({
                event: "finance.morning_audit_report.completed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "RECONCILIATION_FAILED",
                module: "finance-report",
                operation: "sendMorningAuditReport",
                safeContext: {
                    reportDate: dateStr,
                    message: res.message,
                },
            });
            return;
        }

        const reports = reconciliationService.formatReconReport(dateStr, res);

        // Morning audit → SUPER_ADMIN only
        const SUPER_ADMIN_ID = FINANCE_IDS[0];
        if (SUPER_ADMIN_ID) {
            const keyboard = new InlineKeyboard();
            if (reports.actions?.length) {
                keyboard.text(`⚙️ Audit Actions (${reports.actions.length})`, `admin_audit_actions:${dateStr}`);
                // Store actions in Redis (survives restarts, 24h TTL)
                const { redis } = await import("../core/redis.js");
                await redis.set(`audit:actions:${dateStr}`, JSON.stringify(reports.actions), 'EX', 86400);
            }

            const options: any = { parse_mode: "HTML" };
            if (reports.actions?.length) options.reply_markup = keyboard;

            await bot.api.sendMessage(SUPER_ADMIN_ID, reports.main, options);

            for (const chunk of reports.unrecognized) {
                await bot.api.sendMessage(SUPER_ADMIN_ID, chunk, { parse_mode: "HTML" });
            }
            for (const chunk of reports.expenses) {
                await bot.api.sendMessage(SUPER_ADMIN_ID, chunk, { parse_mode: "HTML" });
            }
        }
        logBusinessEvent({
            event: "finance.morning_audit_report.completed",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "finance-report",
            operation: "sendMorningAuditReport",
            safeContext: {
                reportDate: dateStr,
                hasActions: Boolean(reports.actions?.length),
                unrecognizedChunks: reports.unrecognized.length,
                expenseChunks: reports.expenses.length,
            },
        });
    } catch (e) {
        logger.error({ err: e }, "Finance morning audit report failed");
        logBusinessEvent({
            event: "finance.morning_audit_report.completed",
            level: "error",
            actorType: "system",
            actorRole: "system",
            result: "failed",
            module: "finance-report",
            operation: "sendMorningAuditReport",
            error: e,
        });
    }
}

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
            if (minuteOfDay >= 8 * 60) {
                const yesterday = new Date(localDate);
                yesterday.setDate(yesterday.getDate() - 1);

                await reportsQueue.add("send-morning-audit", { dateIso: yesterday.toISOString() }, {
                    jobId: `finance-audit-${todayKey}`,
                    attempts: 3,
                    backoff: { type: "exponential", delay: 10_000 },
                });
            }

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
