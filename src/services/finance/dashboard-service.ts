import { monobankService } from "./monobank.js";
import { techCashService } from "./tech-cash.js";
import { ddsService } from "./dds.js";
import { reconciliationService } from "./reconciliation-service.js";
import { locationRepository } from "../../repositories/location-repository.js";
import logger from "../../core/logger.js";

export interface DailyStatus {
    date: string;
    balances: { name: string; balance?: number; error?: string }[];
    syncStatus: {
        synced: boolean;
        count: number;
    };
    missingReports: string[];
    auditSummary?: {
        mismatches: number;
        totalLocations: number;
    };
}

class DashboardService {
    async getDailyStatus(onWait?: (msg: string) => void): Promise<DailyStatus> {
        const todayStr = new Date().toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" });

        logger.info(`📊 Generating Daily Status for ${todayStr}...`);

        // 1. Get Balances (Parallel)
        const balances = await monobankService.getAllBalances(onWait);

        // 2. Get TechCash data for reports check
        const incomes = await techCashService.getIncomeForDate(todayStr);
        const activeLocations = await locationRepository.findActiveWithSheet();

        const reportKeys = new Set(incomes.map(inc => inc.locationName.toLowerCase()));
        const missingReports = activeLocations
            .filter(l => !reportKeys.has(l.name.toLowerCase()))
            .map(l => `${l.name} (${l.city})`);

        // 3. Check DDS Sync Status
        const ddsTransactions = await ddsService.getTransactionsForDates([todayStr]);

        // 4. Quick Reconciliation Summary
        // Decision: Let's stick to status.missingReports and a placeholder for mismatches.
        // For a real mismatch count, we'd need to run a full reconciliation which is slow.
        // We can show "Ready" or "Check" as a prompt to run the Audit.

        return {
            date: todayStr,
            balances,
            syncStatus: {
                synced: ddsTransactions.length > 0,
                count: ddsTransactions.length
            },
            missingReports,
            auditSummary: {
                mismatches: 0,
                totalLocations: activeLocations.length
            }
        };
    }

    formatStatusReport(status: DailyStatus): string {
        const nowTime = new Date().toLocaleTimeString("uk-UA", { hour: '2-digit', minute: '2-digit', timeZone: "Europe/Kyiv" });
        let report = `📊 <b>STATUS: ${status.date} (${nowTime})</b>\n\n`;

        // --- Balances Table ---
        report += `<b>💰 BALANCES:</b>\n`;
        report += `<code>`;
        report += `══════════════════════════\n`;
        let total = 0;

        for (const b of status.balances) {
            const current = b as any;
            if (!current || !current.name) continue;

            const name = current.name.split(' ')[0].substring(0, 12).padEnd(12, ' ');

            if (current.error || current.balance === undefined) {
                report += `${name} | ERROR\n`;
            } else {
                const bal = Math.round(current.balance).toLocaleString('en-US').replace(/,/g, ' ');
                report += `${name} | ${bal.padStart(8, ' ')} UAH\n`;
                total += current.balance;
            }
        }

        report += `──────────────────────────\n`;
        const totalStr = Math.round(total).toLocaleString('en-US').replace(/,/g, ' ');
        report += `TOTAL        | ${totalStr.padStart(8, ' ')} UAH\n`;
        report += `══════════════════════════\n`;
        report += `</code>\n`;

        return report;
    }
}

export const dashboardService = new DashboardService();
