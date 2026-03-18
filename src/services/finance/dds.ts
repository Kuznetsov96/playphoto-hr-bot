import { existsSync } from "fs";
import logger from "../../core/logger.js";
import { google } from 'googleapis';
import path from 'path';
import { SPREADSHEET_ID_DDS } from "../../config.js";
import { normalizeFinanceString, normalizeFinanceDate } from "./utils.js";

const DDS_SHEET_NAME = "'ДДС месяц'";

class DDSService {
    private auth: any;
    private sheets: any;

    constructor() {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        if (existsSync(KEY_PATH)) {
            this.auth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
        } else {
            this.auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
            this.auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN, scope: 'https://www.googleapis.com/auth/spreadsheets' });
        }
        this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    }

    async addTransaction(data: { date: string; amount: number; fop: string; category: string; comment: string; location?: string; }) {
        try {
            const values = [[null, null, data.date, data.amount, data.fop, "Общее", data.location || "", data.comment, data.category]];
            await this.sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID_DDS,
                range: `${DDS_SHEET_NAME}!A:I`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values },
            }, { timeout: 30000 });
        } catch (error: any) {
            logger.error({ err: error }, "❌ DDS Append Error");
            throw error;
        }
    }

    async getTransactionsForDates(dateStrings: string[]) {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID_DDS,
                range: `${DDS_SHEET_NAME}!A:I`,
            }, { timeout: 30000 });
            const rows = response.data.values;
            if (!rows || rows.length === 0) {
                logger.debug({ dateStrings }, "📭 No rows found in DDS for dates");
                return [];
            }
            const cleanDates = dateStrings.map(d => normalizeFinanceDate(d));
            const filtered = rows
                .filter((r: any[]) => r[2] && cleanDates.includes(normalizeFinanceDate(String(r[2]))))
                .map((r: any[]) => ({
                    date: String(r[2]).trim(),
                    amount: typeof r[3] === 'number' ? r[3] : parseFloat(String(r[3] || "0").replace(/[^\d\.,-]/g, '').replace(',', '.')) || 0,
                    fop: String(r[4] || "").toLowerCase().trim(),
                    location: String(r[6] || "").trim()
                }));

            logger.debug({ dateStrings, found: filtered.length, totalRows: rows.length }, "📥 Fetched transactions from DDS");
            return filtered;
        } catch (error) {
            logger.error({ err: error, dateStrings }, "❌ DDS Fetch Error");
            return [];
        }
    }

    async findTransaction(dateStr: string, amount: number, location: string): Promise<boolean> {
        const existing = await this.getTransactionsForDates([dateStr]);
        return this.matchTransaction(existing, amount, location, dateStr);
    }

    /**
     * Check for duplicate against pre-fetched rows (avoids re-fetching the sheet).
     */
    matchTransaction(existing: { date: string; amount: number; fop: string; location: string }[], amount: number, location: string, dateStr?: string): boolean {
        const targetLocNorm = normalizeFinanceString(location);

        const found = existing.some((tx: any) => {
            if (normalizeFinanceString(tx.location) !== targetLocNorm) return false;

            const diff = Math.abs(tx.amount - amount);
            if (diff < 0.1) return true; // Точний збіг

            // Перевірка на комісію 1.3% (враховуємо обидва напрямки)
            const withFee = Number((amount * 0.987).toFixed(2));
            const fromFee = Number((amount / 0.987).toFixed(2));

            return Math.abs(tx.amount - withFee) < 0.1 || Math.abs(tx.amount - fromFee) < 0.1;
        });

        if (!found && existing.length > 0) {
            logger.debug({ dateStr, amount, location, existingCount: existing.length }, "🔍 No match in DDS for transaction");
        }

        return found;
    }

    async getCellBalance(range: string): Promise<number> {
        try {
            const response = await this.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID_DDS, range });
            const value = response.data.values?.[0]?.[0];
            return value ? parseFloat(String(value).replace(/\s/g, '').replace(',', '.')) || 0 : 0;
        } catch { return 0; }
    }
}

export const ddsService = new DDSService();
