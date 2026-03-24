import { monobankService, monoClients } from "./monobank.js";
import { ddsService } from "./dds.js";
import { DDS_BALANCE_CELLS, FOP_DISPLAY_NAMES, MONO_FOP_IBANS, EXCLUDED_IBANS } from "../../config.js";
import { techCashService } from "./tech-cash.js";
import { normalizeFinanceString, FINANCE_KEYWORDS } from "./utils.js";
import logger from "../../core/logger.js";
import { locationRepository } from "../../repositories/location-repository.js";
import { workShiftRepository } from "../../repositories/work-shift-repository.js";
import { staffRepository } from "../../repositories/staff-repository.js";

interface ReconMatch {
    location: string;
    type: 'Terminal' | 'Cash';
    expected: number;
    actual: number;
    diff: number;
    status: 'OK' | 'MISMATCH' | 'MISSING';
    details?: string;
    staff?: string[];
    staffIds?: string[];
    comment?: string | undefined;
}

interface FopReconResult {
    name: string;
    monoBalance: number;
    ddsBalance: number;
    diff: number;
    matches: ReconMatch[];
}

const CITY_MAP: Record<string, string> = {
    'Запоріжжя': 'Zaporizhzhia', 'Коломия': 'Kolomyya', 'Шептицький': 'Sheptytskyi',
    'Самбір': 'Sambir', 'Рівне': 'Rivne', 'Черкаси': 'Cherkasy', 'Харків': 'Kharkiv',
    'Хмельницький': 'Khmelnytskyi', 'Львів': 'Lviv', 'Київ': 'Kyiv', 'даринок': 'Kyiv'
};

function cityLabel(locCfg: { city: string; name: string; sheet?: string | null }): string {
    const cityRaw = locCfg.city.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const city = CITY_MAP[cityRaw] || cityRaw;

    // Sub-location distinction for Kyiv (Smile Park etc)
    if (city === 'Kyiv' && locCfg.sheet) {
        const sL = locCfg.sheet.toLowerCase();
        if (sL.includes('даринок')) return 'Darynok';
        if (sL.includes('троєщина')) return 'Troieshchyna';
    }
    return city;
}

export class ReconciliationService {
    private isAuditRunning = false;

    async runReconciliation(
        dateStr: string,
        targetFop?: string,
        onProgress?: (msg: string) => Promise<void>,
        incomesOverride?: any[]
    ) {
        if (this.isAuditRunning) return { success: false, message: "Audit is already in progress." };
        this.isAuditRunning = true;

        try {
            const [d, m, y] = dateStr.split('.');
            const targetDate = new Date(Number(y), Number(m) - 1, Number(d));
            const nextDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);

            const [shifts, ddsTxs, allStaff, dbLocations, incomes] = await Promise.all([
                workShiftRepository.findWithRelationsByDateRange(targetDate, nextDate),
                (async () => {
                    const nextDateStr = `${String(nextDate.getDate()).padStart(2, '0')}.${String(nextDate.getMonth() + 1).padStart(2, '0')}.${nextDate.getFullYear()}`;
                    return ddsService.getTransactionsForDates([dateStr, nextDateStr]);
                })(),
                staffRepository.findActive(),
                locationRepository.findAllActive(),
                incomesOverride ? Promise.resolve(incomesOverride) : techCashService.getIncomeForDate(dateStr)
            ]);

            if (dbLocations.length === 0) return { success: false, message: "No active locations." };
            if (!incomes || incomes.length === 0) return { success: false, message: `No TechCash data for ${dateStr}.` };

            const results: FopReconResult[] = [];
            const unrecognized: any[] = [];
            const expenses: any[] = [];

            const from = Math.floor(targetDate.getTime() / 1000);
            const endOfTargetDay = from + 86400;
            const to = from + 259200;

            const fopKeysToAudit = Object.keys(monoClients)
                .map(k => k.toUpperCase())
                .filter(k => !targetFop || k === targetFop.toUpperCase());

            const allRequiredFopKeys = [...new Set([
                ...fopKeysToAudit,
                ...dbLocations.map(l => (l as any).fopId?.toUpperCase()).filter(Boolean)
            ])] as string[];
            if (!allRequiredFopKeys.includes('KUZNETSOV')) allRequiredFopKeys.push('KUZNETSOV');

            const fopPools: Record<string, any[]> = {};
            const fopBalances: Record<string, number> = {};

            await Promise.all(allRequiredFopKeys.map(async (key) => {
                const client = (monoClients as any)[key.toLowerCase()];
                if (!client) return;
                try {
                    // Single getClientInfo call — extracts both account IDs and balance
                    const info = await client.getClientInfo(onProgress ? (msg: string) => onProgress(msg) : undefined);
                    if (!info || !info.accounts) return;

                    const fopIbans = (MONO_FOP_IBANS[key] || []).map((i: string) => i.trim().toUpperCase());
                    const uahAccounts = info.accounts.filter((a: any) => a.currencyCode === 980);
                    const fopAccounts = (fopIbans.length > 0
                        ? uahAccounts.filter((a: any) => a.iban && fopIbans.includes(a.iban.toUpperCase()))
                        : uahAccounts.filter((a: any) => a.type === 'fop' || (a.iban && a.iban.includes('2600'))))
                        .filter((a: any) => !a.iban || !EXCLUDED_IBANS.includes(a.iban.toUpperCase()));
                    const accountIds = fopAccounts.map((a: any) => a.id);
                    if (accountIds.length === 0) return;

                    const txResults = await Promise.all(accountIds.map((id: string) => client.getStatements(id, from, to)));
                    fopPools[key] = txResults.flat().map((tx: any) => ({ data: tx, claimed: false, fop: key }));

                    // Balance already available from the same getClientInfo response
                    fopBalances[key] = fopAccounts.reduce((sum: number, acc: any) => sum + (acc.balance / 100), 0);
                } catch (e) { logger.error({ err: e }, `❌ Mono fetch failed for ${key}`); }
            }));

            const ddsBalances: Record<string, number> = {};
            await Promise.all(fopKeysToAudit.map(async (key) => {
                const ddsCell = DDS_BALANCE_CELLS[key];
                ddsBalances[key] = ddsCell ? await ddsService.getCellBalance(ddsCell) : 0;
            }));

            const allKnownTerminalIds = dbLocations.map(l => (l as any).terminalId?.toLowerCase()).filter(Boolean);

            for (const key of fopKeysToAudit) {
                const pool = fopPools[key] || [];
                const monoBalance = fopBalances[key] || 0;
                const ddsBalance = ddsBalances[key] || 0;
                const targetFopNorm = normalizeFinanceString(FOP_DISPLAY_NAMES[key] || key);
                const fopSurnameNorm = normalizeFinanceString(key.replace('FOP_', ''));
                const isKuz = key === 'KUZNETSOV';
                const fopMatches: ReconMatch[] = [];

                const relevantLocs = isKuz ? dbLocations : dbLocations.filter(l => (l as any).fopId?.toUpperCase() === key);

                for (const locCfg of relevantLocs) {
                    try {
                        const inc = incomes.find(i => i.locationId === locCfg.id);
                        const locShifts = shifts.filter((s: any) => s.locationId === locCfg.id);
                        const displaySurnames = locShifts.map((s: any) => s.staff?.fullName?.split(' ')[0]).filter(Boolean) as string[];
                        const staffIds = locShifts.map((s: any) => s.staff?.user?.telegramId).filter(Boolean).map(id => String(id));
                        const isFopMatch = (locCfg as any).fopId?.toUpperCase() === key;

                        if (isFopMatch || (isKuz && !!(locCfg as any).searchId)) {
                            const termExpRaw = inc?.totalTerminal || 0;
                            const termExp = isFopMatch ? termExpRaw : 0;

                            if (termExpRaw > 0 || (locCfg as any).terminalId || (locCfg as any).searchId) {
                                const candidates = pool.filter(item => {
                                    if (item.claimed || item.data.amount <= 0) return false;
                                    const combined = ((item.data.description || '') + " " + (item.data.comment || '')).toLowerCase();
                                    if ((locCfg as any).terminalId && combined.includes((locCfg as any).terminalId.toLowerCase())) {
                                        return item.data.time >= endOfTargetDay && item.data.time < endOfTargetDay + 172800;
                                    }
                                    if ((locCfg as any).searchId) {
                                        const idRegex = new RegExp(`(?:ф[оo]т[оo]|друк|ф|№|#|ід|id|п)[\\.\\s:]*${String((locCfg as any).searchId)}(\\D|$)`, 'i');
                                        if (idRegex.test(combined)) {
                                            // If the transaction description contains a staff surname,
                                            // it's likely a staff P2P transfer (not a client terminal payment)
                                            // — skip it here so it can be matched as cash instead
                                            const normC = normalizeFinanceString(combined);
                                            const isStaffTx = displaySurnames.some(s => normC.includes(normalizeFinanceString(s)));
                                            if (!isStaffTx) return true;
                                        }
                                    }
                                    if (isFopMatch && !((locCfg as any).terminalId) && !((locCfg as any).searchId) && inc) {
                                        return normalizeFinanceString(combined).includes(normalizeFinanceString(inc.locationName));
                                    }
                                    return false;
                                });

                                const fee = (locCfg as any).hasAcquiring ? 0.013 : 0;
                                const actual = candidates.reduce((sum: number, item: any) => sum + item.data.amount / 100, 0);
                                const fullNameNorm = normalizeFinanceString(locCfg.name.includes(locCfg.city) ? locCfg.name : `${locCfg.name} ${locCfg.city}`);

                                const ddsForLoc = ddsTxs.filter((tx: any) => {
                                    const dfn = normalizeFinanceString(tx.fop);
                                    if (!(dfn.includes(targetFopNorm) || targetFopNorm.includes(dfn) || (fopSurnameNorm.length > 3 && dfn.includes(fopSurnameNorm)))) return false;
                                    const dln = normalizeFinanceString(tx.location);
                                    return dln.includes(fullNameNorm) && (dln.includes(FINANCE_KEYWORDS.TERMINAL) || dln.includes(FINANCE_KEYWORDS.TERMINAL_EN) || dln.includes(FINANCE_KEYWORDS.ACQUIRING));
                                });

                                const ddsTotal = ddsForLoc.reduce((sum: number, tx: any) => sum + tx.amount, 0);
                                candidates.forEach(c => c.claimed = true);

                                const expectedAfterFee = termExp * (1 - fee);
                                const diff = Math.abs(actual - expectedAfterFee) < 0.5 ? 0 : (actual - termExp);

                                if (termExp > 0 || actual > 0) {
                                    fopMatches.push({
                                        location: `${locCfg.name} (${cityLabel(locCfg)})`,
                                        type: 'Terminal', expected: termExp, actual, diff,
                                        status: Math.abs(diff) > 0.5 ? (actual === 0 ? 'MISSING' : 'MISMATCH') : 'OK',
                                        details: (candidates.length > 1 ? `(${candidates.length} пл.)` : '') + (fee > 0 ? ' (ком. 1.3%)' : '') + (actual > 0 && Math.abs(actual - ddsTotal) > 1 ? ' ⚠️ NOT IN DDS' : ''),
                                        staff: displaySurnames,
                                        staffIds,
                                        comment: inc?.comment
                                    });
                                }
                            }
                        }

                        if (isKuz) {
                            const totalCash = inc?.totalCash || 0;
                            const perPersonSalary = inc?.totalSalary || 0;
                            const staffCount = Math.max(locShifts.length, 1);
                            const totalSalary = perPersonSalary * staffCount;
                            const cashExp = totalCash - totalSalary;

                            if (totalCash > 0 || displaySurnames.length > 0) {
                                const candidates = pool.filter(item => {
                                    if (item.claimed || item.data.amount <= 0) return false;
                                    const normC = normalizeFinanceString((item.data.description || '') + " " + (item.data.comment || ''));
                                    const hasWorker = displaySurnames.some(s => normC.includes(normalizeFinanceString(s)));
                                    const hasLoc = normC.includes(normalizeFinanceString(locCfg.name)) || (locCfg as any).sheet && normC.includes(normalizeFinanceString((locCfg as any).sheet.replace('Каса ', '')));
                                    const isGeneric = normC.includes(FINANCE_KEYWORDS.INCOME) || normC.includes(FINANCE_KEYWORDS.CASHBOX) || normC.includes(FINANCE_KEYWORDS.REPORT);
                                    return hasWorker || (hasLoc && isGeneric);
                                });

                                const actual = candidates.reduce((sum: number, item: any) => sum + item.data.amount / 100, 0);
                                const fullNameNorm = normalizeFinanceString(locCfg.name.includes(locCfg.city) ? locCfg.name : `${locCfg.name} ${locCfg.city}`);
                                const ddsForLoc = ddsTxs.filter((tx: any) => {
                                    const dfn = normalizeFinanceString(tx.fop);
                                    if (!(dfn.includes(targetFopNorm) || targetFopNorm.includes(dfn) || (fopSurnameNorm.length > 3 && dfn.includes(fopSurnameNorm)))) return false;
                                    const dln = normalizeFinanceString(tx.location);
                                    return dln.includes(fullNameNorm) && (dln.includes(FINANCE_KEYWORDS.CASH) || dln.includes(FINANCE_KEYWORDS.CASH_EN) || dln.includes(FINANCE_KEYWORDS.CASH_RU));
                                });
                                const ddsTotal = ddsForLoc.reduce((sum: number, tx: any) => sum + tx.amount, 0);
                                candidates.forEach(c => c.claimed = true);
                                const isEnv = !!(locCfg as any).cashInEnvelope;

                                let diff = isEnv ? 0 : (actual - cashExp);
                                let autoStatus = isEnv ? 'OK' : (Math.abs(diff) < 0.5 ? 'OK' : (actual === 0 ? 'MISSING' : 'MISMATCH'));
                                let autoDetails = (candidates.length > 1 ? `(${candidates.length} пл.)` : '') + (isEnv ? ' (конверт)' : '') + (!isEnv && actual > 0 && Math.abs(actual - ddsTotal) > 1 ? ' ⚠️ NOT IN DDS' : '');

                                // --- INFORMATIVE LABELS (no DB writes) ---
                                if (!isEnv && autoStatus !== 'OK') {
                                    if (totalCash < totalSalary && actual === 0) {
                                        const deficit = totalSalary - totalCash;
                                        autoDetails += ` ℹ️ Salary > Cash: -${Math.round(deficit)} UAH (no transfer expected)`;
                                    } else if (diff < 0 && !inc?.comment) {
                                        const shortage = Math.abs(diff);
                                        autoDetails += ` ⚠️ Salary shortage: -${Math.round(shortage)} UAH (no comment)`;
                                    }
                                }

                                if (cashExp > 0 || totalCash > 0 || actual > 0) {
                                    fopMatches.push({
                                        location: `${locCfg.name} (${cityLabel(locCfg)})`,
                                        type: 'Cash',
                                        expected: isEnv ? 0 : (cashExp < 0 ? 0 : cashExp),
                                        actual,
                                        diff,
                                        status: autoStatus as any,
                                        details: autoDetails,
                                        staff: displaySurnames,
                                        staffIds,
                                        comment: inc?.comment
                                    });
                                }
                            }
                        }
                    } catch (e) { logger.error({ err: e, loc: locCfg.name }, "Loc error"); }
                }

                // Phase 2.7: Cleanup with DDS (Strict 1.3% check)
                pool.forEach(item => {
                    if (item.claimed) return;
                    const val = item.data.amount / 100;
                    const idx = ddsTxs.findIndex((tx: any) => {
                        const dfn = normalizeFinanceString(tx.fop);
                        const isFop = dfn.includes(targetFopNorm) || targetFopNorm.includes(dfn) || (fopSurnameNorm.length > 3 && dfn.includes(fopSurnameNorm));
                        if (!isFop) return false;

                        const absVal = Math.abs(val);
                        const absTx = Math.abs(tx.amount);
                        const diff = Math.abs(absVal - absTx);
                        return diff < 0.1 || Math.abs(absVal * 0.987 - absTx) < 0.1 || Math.abs(absVal / 0.987 - absTx) < 0.1;
                    });
                    if (idx !== -1) {
                        item.claimed = true;
                        ddsTxs.splice(idx, 1);
                    }
                });

                results.push({ name: key, monoBalance, ddsBalance, diff: monoBalance - ddsBalance, matches: fopMatches });

                // PHASE 3: Collect Remaining
                pool.forEach(item => {
                    if (item.claimed) return;
                    const combined = ((item.data.description || '') + " " + (item.data.comment || '')).toLowerCase();

                    // Filter out ANY known terminal payouts from unrecognized
                    const isKnownTerminal = allKnownTerminalIds.some(tid => combined.includes(tid));
                    if (isKnownTerminal) return;

                    const isDayT = item.data.time >= from && item.data.time < endOfTargetDay;
                    const isPotentialTerminal = combined.includes('pq') || combined.includes('термінал') || combined.includes('terminal');

                    // Logic for Unrecognized:
                    // - On Day T: Show only NON-terminal items (Terminal payouts on Day T belong to Day T-1).
                    // - After Day T: Show only POTENTIAL terminal items (Failed matches for Day T).
                    //   Manual transfers arriving after Day T belong to those respective days (T+1, T+2).

                    if (isDayT) {
                        if (!isPotentialTerminal) {
                            if (item.data.amount > 0) unrecognized.push({ ...item.data, fop: key });
                            else expenses.push({ ...item.data, fop: key });
                        }
                    } else {
                        // Day T+1 or T+2
                        if (isPotentialTerminal) {
                            if (item.data.amount > 0) unrecognized.push({ ...item.data, fop: key });
                            // Note: we don't usually track unrecognized expenses for Day T that arrived on T+1
                        }
                    }
                });
            }
            return { success: true, results, unrecognized, expenses, incomes, allStaff };
        } finally { this.isAuditRunning = false; }
    }

    public formatReconReport(dateStr: string, res: any): { main: string; unrecognized: string[]; expenses: string[]; actions: any[] } {
        const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const fmt = (n: number) => n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const now = new Date().toLocaleTimeString("uk-UA", { hour: '2-digit', minute: '2-digit', timeZone: "Europe/Kyiv" });
        let main = `⚖️ <b>AUDIT REPORT • ${dateStr} (${now})</b>\n\n`;
        const actions: any[] = [];

        res.results?.forEach((fop: any) => {
            main += `👤 <b>FOP ${esc(fop.name)}</b>\n`;
            const problems = fop.matches.filter((m: any) => m.status !== 'OK' || (m.details && m.details.includes('NOT IN DDS')));
            problems.sort((a: any, b: any) => (a.status === 'MISSING' ? -1 : 1) || Math.abs(b.diff) - Math.abs(a.diff));

            problems.forEach((m: any) => {
                let icon = m.status === 'MISSING' ? '⭕' : (m.diff < 0 ? '🔻' : '🔺');
                if (m.status === 'OK' && m.details.includes('NOT IN DDS')) icon = '⚠️';
                const type = m.type === 'Terminal' ? '💳' : '💵';
                const staff = m.staff?.length ? ` [${m.staff.join('/')}]` : '';
                const dL = m.diff === 0 ? '0' : (m.diff > 0 ? `+${fmt(m.diff)}` : fmt(m.diff));
                main += `   ${icon} ${type} ${esc(m.location)}${esc(staff)}: ${fmt(m.expected)} → ${fmt(m.actual)} (${dL})${m.details}\n`;
                if (m.comment) {
                    main += `      💬 <i>${esc(m.comment)}</i>\n`;
                } else if (m.status !== 'OK' && m.staffIds?.length) {
                    // No comment and there is a mismatch - add to actions
                    actions.push({
                        location: m.location,
                        type: m.type,
                        diff: m.diff,
                        staffIds: m.staffIds,
                        staffNames: m.staff
                    });
                }
            });

            const ok = fop.matches.length - problems.length;
            if (ok > 0) main += `   ✅ <i>${ok} other locations match</i>\n`;

            const d = fop.diff;
            main += Math.abs(d) < 0.01 ? `   💰 <b>BALANCE:</b> ✅ <code>${fmt(fop.monoBalance)} UAH</code>\n\n` :
                `   💰 <b>BALANCE:</b> 🏦 ${fmt(fop.monoBalance)} | 📊 ${fmt(fop.ddsBalance)} (${d > 0 ? '🔺' : '🔻'} ${fmt(Math.abs(d))})\n\n`;
        });

        // Build staff surname → debt map for unrecognized hints
        const staffDebtMap = new Map<string, { name: string; balance: number }>();
        if (res.allStaff) {
            for (const s of res.allStaff) {
                const balance = (s as any).salaryBalance || 0;
                if (balance > 0 && s.fullName) {
                    const surname = s.fullName.split(' ')[0];
                    if (surname) staffDebtMap.set(normalizeFinanceString(surname), { name: s.fullName, balance });
                }
            }
        }

        const formatExtra = (title: string, list: any[], addDebtHint = false) => {
            const chunks: string[] = [];
            if (!list?.length) return chunks;
            let current = `${title}\n`;
            list.forEach((tx: any) => {
                const combined = ((tx.description || '') + " " + (tx.comment || '')).toLowerCase();
                const tidMatch = combined.match(/pq\d+/);
                const tidInfo = tidMatch ? ` [ID: <code>${tidMatch[0].toUpperCase()}</code>]` : '';
                let debtHint = '';
                if (addDebtHint && tx.amount > 0) {
                    const normDesc = normalizeFinanceString(tx.description || '');
                    for (const [normSurname, info] of staffDebtMap) {
                        if (normDesc.includes(normSurname)) {
                            debtHint = ` 💡 Debt: ${info.balance} UAH`;
                            break;
                        }
                    }
                }
                const line = `   • ${tx.amount / 100} UAH - <i>${esc(tx.description || '')} ${esc(tx.comment || '')}</i> [${esc(tx.fop)}]${tidInfo}${debtHint}\n`;
                if (current.length + line.length > 4000) { chunks.push(current); current = `${title} (cont.)\n`; }
                current += line;
            });
            chunks.push(current);
            return chunks;
        };

        return {
            main,
            unrecognized: formatExtra(`❓ <b>UNRECOGNIZED INCOMING:</b>`, res.unrecognized, true),
            expenses: formatExtra(`💸 <b>EXPENSES (not categorized):</b>`, res.expenses),
            actions
        };
    }
}

export const reconciliationService = new ReconciliationService();
