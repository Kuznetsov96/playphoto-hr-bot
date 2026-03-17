import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { MONO_TOKENS } from "../../config.js";
import { redis } from "../../core/redis.js";
import prisma from "../../db/core.js";
import logger from "../../core/logger.js";

const BASE_URL = "https://api.monobank.ua";

class MonobankClient {
    private token: string;
    private name: string;
    private queue: Promise<any> = Promise.resolve();

    constructor(token: string, name: string) {
        this.token = (token || '').trim();
        this.name = name.toUpperCase();
    }

    private async delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async fetchWithAuth(endpoint: string, onWait?: (msg: string) => void): Promise<any> {
        // Add to queue to process requests for THIS token sequentially
        const result = this.queue.then(() => this._doFetch(endpoint, 0, onWait));

        // Ensure errors don't break the queue chain
        this.queue = result.catch(() => { });
        return result;
    }

    private async _doFetch(endpoint: string, retryCount: number = 0, onWait?: (msg: string) => void): Promise<any> {
        const redisKey = `mono:last_request:${this.name}`;
        const minInterval = 61000; // 61s

        let lastRequestStr = await redis.get(redisKey);
        let lastRequestTime = lastRequestStr ? parseInt(lastRequestStr) : 0;

        const now = Date.now();
        let timeSinceLast = now - lastRequestTime;

        if (timeSinceLast < minInterval) {
            const waitTime = minInterval - timeSinceLast;
            let seconds = Math.ceil(waitTime / 1000);

            console.log(`⏳ Monobank [${this.name}]: Rate limit safety wait ${seconds}s...`);

            if (onWait) {
                Promise.resolve(onWait(`⏳ Monobank [${this.name}]: Rate limit. Waiting ${seconds}s...`)).catch(() => { });
            }

            await this.delay(waitTime);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s timeout

        try {
            await redis.set(redisKey, Date.now().toString(), 'EX', 3600);

            const response = await fetch(`${BASE_URL}${endpoint}`, {
                headers: { "X-Token": this.token },
                signal: controller.signal as any
            } as any);

            if (response.status === 429) {
                console.warn(`⚠️ Monobank [${this.name}] returned 429. Retry in 60s...`);
                await this.delay(61000);
                return this._doFetch(endpoint, retryCount + 1, onWait);
            }

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Monobank API Error [${this.name}] ${response.status}: ${text}`);
            }

            return await response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async getClientInfo(onWait?: (msg: string) => void) {
        const cacheKey = `mono:client_info:${this.name}`;
        const metaKey = `mono:metadata:${this.name}`;
        
        // 1. Try Redis Cache (30 min TTL) for full info (with balance)
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (e) {
            logger.error({ err: e }, "Redis Cache read failed");
        }

        // 2. API Fetch
        logger.info(`🌐 Monobank [${this.name}]: Fetching fresh client info...`);
        const info = await this.fetchWithAuth("/personal/client-info", onWait);

        // 3. Save to Redis (1800s = 30 minutes)
        try {
            await redis.set(cacheKey, JSON.stringify(info), 'EX', 1800);
            // Save Metadata (Account Structure) for long-term (no TTL)
            if (info.accounts) {
                await redis.set(metaKey, JSON.stringify(info.accounts));
            }
        } catch (e) {
            logger.error({ err: e }, "Redis Cache write failed");
        }

        return info;
    }

    /**
     * Tries to get client info ONLY from cache.
     * Useful for reconciliation where we don't want to trigger 60s wait if balance is already known.
     */
    async getClientInfoCached() {
        const cacheKey = `mono:client_info:${this.name}`;
        try {
            const cached = await redis.get(cacheKey);
            if (cached) return JSON.parse(cached);
        } catch (e) {}
        return null;
    }

    /**
     * Returns account IDs for given IBANs without hitting the API if metadata is cached.
     * Filters for UAH accounts (currencyCode: 980) to avoid redundant statement requests.
     */
    async getAccountIdsByIbans(targetIbans: string[]): Promise<string[]> {
        const metaKey = `mono:metadata:${this.name}`;
        let accounts = [];

        try {
            const cached = await redis.get(metaKey);
            if (cached) {
                accounts = JSON.parse(cached);
            } else {
                const info = await this.getClientInfo();
                accounts = info.accounts || [];
            }
        } catch (e) {
            const info = await this.getClientInfo();
            accounts = info.accounts || [];
        }

        const normalizedTargets = targetIbans.map(i => i.trim().toUpperCase()).filter(Boolean);

        // Filter: We only care about UAH accounts (980)
        const uahAccounts = accounts.filter((acc: any) => acc.currencyCode === 980);

        // 1. If explicit IBANs are provided in config, use ONLY them. No guessing.
        if (normalizedTargets.length > 0) {
            return uahAccounts
                .filter((acc: any) => acc.iban && normalizedTargets.includes(acc.iban.toUpperCase()))
                .map((acc: any) => acc.id);
        }

        // 2. Fallback: Only if NO IBANs are configured, try to detect FOP-like accounts
        return uahAccounts
            .filter((acc: any) => acc.type === 'fop' || (acc.iban && acc.iban.includes('2600')))
            .map((acc: any) => acc.id);
    }

    async getStatements(accountId: string, from: number, to: number = Math.floor(Date.now() / 1000), onWait?: (msg: string) => void) {
        return await this.fetchWithAuth(`/personal/statement/${accountId}/${from}/${to}`, onWait);
    }

    async generateHtmlStatement(accountId: string, from: number, to: number, clientName: string, onWait?: (msg: string) => void) {
        const transactions = await this.getStatements(accountId, from, to, onWait);
        if (!transactions || !Array.isArray(transactions)) return null;

        const totalIn = transactions.filter((t: any) => t.amount > 0).reduce((sum: number, t: any) => sum + t.amount, 0) / 100;
        const totalOut = transactions.filter((t: any) => t.amount < 0).reduce((sum: number, t: any) => sum + t.amount, 0) / 100;

        const fromDateStr = new Date(from * 1000).toLocaleDateString('uk-UA');
        const toDateStr = new Date(to * 1000).toLocaleDateString('uk-UA');

        let html = `
        <!DOCTYPE html>
        <html lang="uk">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Виписка Monobank - ${clientName}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f0f2f5; margin: 0; padding: 20px; color: #333; }
                .container { max-width: 900px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); overflow: hidden; }
                .header { background: #000; color: white; padding: 20px; display: flex; justify-content: space-between; align-items: center; }
                .logo { font-size: 20px; font-weight: bold; border: 2px solid white; padding: 4px 10px; border-radius: 8px; }
                .client-info { text-align: right; }
                .client-name { font-size: 18px; font-weight: 600; }
                .period { font-size: 14px; opacity: 0.8; }
                .summary { padding: 20px; background: #f8f9fa; border-bottom: 1px solid #eee; display: flex; gap: 20px; }
                .metric { flex: 1; }
                .metric-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
                .metric-value { font-size: 22px; font-weight: 600; }
                
                table { width: 100%; border-collapse: collapse; font-size: 14px; }
                th { text-align: left; padding: 12px 15px; color: #666; font-weight: 500; border-bottom: 1px solid #eee; background: #fff; position: sticky; top: 0; }
                td { padding: 12px 15px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
                tr:hover td { background: #fafafa; }
                
                .amount { font-weight: 600; text-align: right; white-space: nowrap; }
                .amount.positive { color: #2ecc71; }
                .amount.negative { color: #e74c3c; }
                
                .date-cell { color: #999; font-size: 12px; width: 80px; }
                .desc-cell { max-width: 400px; }
                .comment { color: #666; font-size: 12px; font-style: italic; margin-top: 2px; }
                .balance-col { color: #999; font-weight: 400; text-align: right; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div class="logo">M</div>
                    <div class="client-info">
                        <div class="client-name">${clientName}</div>
                        <div class="period">${fromDateStr} — ${toDateStr}</div>
                    </div>
                </div>
                <div class="summary">
                    <div class="metric">
                        <div class="metric-label">Надходження</div>
                        <div class="metric-value" style="color: #2ecc71">+${totalIn.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</div>
                    </div>
                    <div class="metric">
                        <div class="metric-label">Витрати</div>
                        <div class="metric-value" style="color: #e74c3c">${totalOut.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}</div>
                    </div>
                    <div class="metric">
                        <div class="metric-label">Операцій</div>
                        <div class="metric-value">${transactions.length}</div>
                    </div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Час</th>
                            <th>Опис</th>
                            <th style="text-align: right">Сума</th>
                            <th style="text-align: right">Баланс</th>
                        </tr>
                    </thead>
                    <tbody>`;

        for (const tx of transactions) {
            const dt = new Date(tx.time * 1000);
            const dateS = dt.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
            const timeS = dt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

            const amount = tx.amount / 100;
            const balance = tx.balance / 100;

            const amountCls = amount > 0 ? "positive" : "negative";
            const sign = amount > 0 ? "+" : "";

            html += `
                        <tr>
                            <td class="date-cell">
                                <div>${dateS}</div>
                                <div>${timeS}</div>
                            </td>
                            <td class="desc-cell">
                                <div>${tx.description || ''}</div>
                                ${tx.comment ? `<div class="comment">${tx.comment}</div>` : ''}
                            </td>
                            <td class="amount ${amountCls}">
                                ${sign}${amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                            </td>
                            <td class="amount balance-col">
                                ${balance.toLocaleString('uk-UA', { minimumFractionDigits: 2 })}
                            </td>
                        </tr>`;
        }

        html += `
                    </tbody>
                </table>
            </div>
        </body>
        </html>`;
        return html;
    }

    async generateCsvStatement(accountId: string, from: number, to: number) {
        const transactions = await this.getStatements(accountId, from, to);
        if (!transactions || !Array.isArray(transactions)) return null;

        let csv = "Дата;Час;Опис;Сума;Баланс;Коментар\n";
        for (const tx of transactions) {
            const dt = new Date(tx.time * 1000);
            const dateS = dt.toLocaleDateString('uk-UA');
            const timeS = dt.toLocaleTimeString('uk-UA');

            const amount = (tx.amount / 100).toString().replace('.', ',');
            const balance = (tx.balance / 100).toString().replace('.', ',');
            const desc = (tx.description || '').replace(/;/g, ' ');
            const comment = (tx.comment || '').replace(/;/g, ' ');

            csv += `${dateS};${timeS};${desc};${amount};${balance};${comment}\n`;
        }
        return csv;
    }
}

export const monoClients = {
    kuznetsov: new MonobankClient(MONO_TOKENS.KUZNETSOV, "Kuznetsov"),
    posrednikova: new MonobankClient(MONO_TOKENS.POSREDNIKOVA, "Posrednikova"),
    karpuk: new MonobankClient(MONO_TOKENS.KARPUK, "Karpuk"),
    gupalova: new MonobankClient(MONO_TOKENS.GUPALOVA, "Gupalova")
};

export const monobankService = {
    async getAllBalances(onWait?: (msg: string) => void) {
        const { MONO_FOP_IBANS } = await import("../../config.js");

        const promises = Object.entries(monoClients).map(async ([key, client]) => {
            try {
                const info: any = await client.getClientInfo(onWait);
                const uahAccounts = info.accounts.filter((a: any) => a.currencyCode === 980);

                const fopIbans = (MONO_FOP_IBANS[key.toUpperCase()] || []).map(i => i.trim().toUpperCase());
                let fopAccounts = uahAccounts.filter((acc: any) => {
                    const accIban = (acc.iban || '').toUpperCase();
                    if (fopIbans.length > 0) {
                        return fopIbans.includes(accIban);
                    }
                    // Traditional FOP type
                    if (acc.type === 'fop') return true;
                    // IBAN detection: 2600 is for business/FOP in Ukraine
                    if (accIban.includes('2600')) return true;
                    return false;
                });

                // Extreme Fallback: If still nothing but we have only one UAH account, it's likely it
                if (fopAccounts.length === 0 && uahAccounts.length === 1) {
                    fopAccounts = uahAccounts;
                }

                let totalBalance = 0;
                fopAccounts.forEach((acc: any) => {
                    totalBalance += (acc.balance / 100);
                });

                if (uahAccounts.length > 0) {
                    logger.info(`[MONO] FOP ${key}: Found ${fopAccounts.length} FOP accounts out of ${uahAccounts.length} Total. Key: ${key.toUpperCase()}`);
                    uahAccounts.forEach((a: any) => {
                        logger.info(`   - Account: IBAN ${a.iban.substring(0, 10)}...${a.iban.slice(-4)}, Type: ${a.type}, ID: ${a.id}`);
                    });
                    
                    if (fopAccounts.length === 0) {
                        logger.warn(`[MONO] ${key} has UAH accounts but NONE matched IBAN list or 'fop' type.`);
                    }
                }

                return {
                    name: (info.name || key),
                    balance: totalBalance,
                    accounts: fopAccounts.length
                };
            } catch (e: any) {
                return { name: key, error: e.message };
            }
        });

        return await Promise.all(promises);
    }
};
