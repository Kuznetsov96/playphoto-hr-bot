import { reconciliationService } from "../src/services/finance/reconciliation-service.js";
import { ddsService } from "../src/services/finance/dds.js";
import { monoClients } from "../src/services/finance/monobank.js";
import { MONO_FOP_IBANS } from "../src/config.js";

async function run() {
    const dateStr = "15.03.2026";
    console.log(`🔍 DEEP DEBUG AUDIT FOR ${dateStr}`);

    try {
        // 1. Check Monobank Raw Data
        for (const [key, client] of Object.entries(monoClients)) {
            const fopKey = key.toUpperCase();
            const ibans = MONO_FOP_IBANS[fopKey] || [];
            const accIds = await (client as any).getAccountIdsByIbans(ibans);
            
            console.log(`\n👤 Monobank [${fopKey}] (Accs: ${accIds.length}):`);
            
            const from = Math.floor(new Date(2026, 2, 15).getTime() / 1000);
            const to = from + 259200; // 72h

            for (const id of accIds) {
                const txs = await (client as any).getStatements(id, from, to);
                console.log(`  - Account ${id}: Found ${txs.length} transactions in window.`);
                txs.forEach((tx: any) => {
                    const amt = tx.amount / 100;
                    if (amt > 0) {
                        console.log(`    [TX] ${new Date(tx.time * 1000).toISOString()} | ${amt} UAH | ${tx.description} | ${tx.comment || ''}`);
                    }
                });
            }
        }

        // 2. Check DDS Raw Data
        const nextDate = new Date(2026, 2, 16);
        const nextDateStr = "16.03.2026";
        const ddsTxs = await ddsService.getTransactionsForDates([dateStr, nextDateStr]);
        console.log(`\n📊 DDS Transactions Found: ${ddsTxs.length}`);
        ddsTxs.forEach(tx => {
            console.log(`  [DDS] ${tx.date} | ${tx.fop} | ${tx.amount} UAH | ${tx.location} | ${tx.comment}`);
        });

    } catch (e) {
        console.error("DEBUG ERROR:", e);
    }
}

run();
