import { existsSync } from "fs";
import { google } from "googleapis";
import path from "path";
import { SPREADSHEET_ID_TECH_CASH } from "../../config.js";
import logger from "../../core/logger.js";
import { locationRepository } from "../../repositories/location-repository.js";


export interface TechCashIncome {
    locationId: string;    // Unique ID from DB
    locationName: string; // The official name from config
    city: string;         // City for disambiguation
    totalCash: number;
    totalTerminal: number;
    totalSalary?: number;
    totalIncome: number;
    date: string;
    photographers?: string[]; // Names from Col B, C
    comment?: string;         // Col I
}

class TechCashService {
    private auth: any;
    private sheets: any;

    constructor() {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        const hasServiceAccount = existsSync(KEY_PATH);


        if (hasServiceAccount) {
            logger.debug("🎫 Using google-service-account.json for TechCash");
            this.auth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
        } else if (process.env.GOOGLE_REFRESH_TOKEN) {
            logger.debug("🎫 Using GOOGLE_REFRESH_TOKEN (OAuth2) for TechCash");
            this.auth = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            this.auth.setCredentials({
                refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
                scope: 'https://www.googleapis.com/auth/spreadsheets'
            });
        }
        this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    }

    /**
     * Reads income data for a specific date from all configured locations.
     */
    async getIncomeForDate(dateStr: string): Promise<TechCashIncome[]> {
        const results: TechCashIncome[] = [];

        // Fetch active locations from DB
        const dbLocations = await locationRepository.findActiveWithSheet();

        if (dbLocations.length === 0) {
            logger.warn("⚠️ No locations configured for TechCash sync in DB.");
            return [];
        }

        // Parse target date components
        const parts = dateStr.split('.');
        if (parts.length < 3) return [];
        const targetDay = parseInt(parts[0]!);
        const targetMonth = parseInt(parts[1]!);
        const targetYear = parseInt(parts[2]!);

        logger.info({ dateStr, targetDay, targetMonth, targetYear }, "🔍 Searching TechCash for date");

        // Helper to process rows for a single location
        const processRows = (rows: any[], loc: any) => {
            if (!rows || rows.length === 0) return;
            // Log last few cells in column A for debugging
            const lastCells = rows.slice(-5).map((r: any[]) => String(r[0] || "").trim()).filter(Boolean);
            logger.info({ location: loc.name, lastDates: lastCells }, "📋 TechCash sheet tail (col A)");

            // Find all matching rows by parsing date from cell
            const matchingRows = rows.filter((r: any[]) => {
                if (!r[0]) return false;
                const cell = String(r[0]).trim();
                // Extract all numbers from the cell
                const nums = cell.match(/\d+/g);
                if (!nums || nums.length < 2) return false;
                const a = parseInt(nums[0]!), b = parseInt(nums[1]!), c = nums[2] ? parseInt(nums[2]!) : 0;
                let cd: number, cm: number, cy: number;
                if (a > 31) {
                    // YYYY-MM-DD or YYYY.MM.DD
                    cy = a; cm = b; cd = c;
                } else if (b > 12) {
                    // DD.YYYY — only 2 numbers, month is missing (e.g. "16 лют. 2026")
                    // Fall back: just match day + year
                    cd = a; cm = 0; cy = b;
                } else {
                    // DD.MM.YYYY or DD.MM.YY or DD/MM/YYYY
                    cd = a; cm = b; cy = c;
                }
                if (cy > 0 && cy < 100) cy += 2000;
                // If month couldn't be parsed, match day + year only
                if (cm === 0) return cd === targetDay && cy === targetYear;
                return cd === targetDay && cm === targetMonth && (cy === 0 || cy === targetYear);
            });

            const todayRow = matchingRows.length > 0 ? matchingRows[matchingRows.length - 1] : null;

            if (todayRow) {
                const normalize = (val: any) => {
                    if (typeof val === 'number') return val;
                    return parseFloat(String(val || "0").replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '')) || 0;
                };

                const photog1 = String(todayRow[1] || "").trim();
                const photog2 = String(todayRow[2] || "").trim();
                const photographers = [photog1, photog2].filter(p => p.length > 2);

                const cash = normalize(todayRow[3]);     // Col D
                const terminal = normalize(todayRow[4]); // Col E
                const salary = normalize(todayRow[7]);   // Col H
                const comment = String(todayRow[8] || "").trim(); // Col I

                results.push({
                    locationId: loc.id,
                    locationName: loc.name,
                    city: loc.city,
                    totalCash: cash,
                    totalTerminal: terminal,
                    totalSalary: salary,
                    totalIncome: cash + terminal,
                    date: dateStr,
                    photographers,
                    comment
                });
            } else {
                logger.warn({ location: loc.name, sheet: (loc as any).sheet }, "⚠️ No matching date row found in TechCash sheet");
            }
        };

        // Try batchGet first (faster), fall back to individual requests on failure
        const ranges = dbLocations.map(loc => `${(loc as any).sheet}!A:Z`);

        try {
            const res = await this.sheets.spreadsheets.values.batchGet({
                spreadsheetId: SPREADSHEET_ID_TECH_CASH,
                ranges: ranges,
                valueRenderOption: 'FORMATTED_VALUE'
            });

            const valueRanges = res.data.valueRanges;

            if (valueRanges && valueRanges.length === dbLocations.length) {
                valueRanges.forEach((range: any, index: number) => {
                    const loc = dbLocations[index];
                    if (!loc) return;
                    processRows(range.values, loc);
                });
            }
        } catch (batchErr: any) {
            logger.warn({ err: batchErr.message }, "⚠️ batchGet failed, falling back to individual sheet requests");

            // Fall back: fetch each sheet individually so one bad sheet doesn't break everything
            for (const loc of dbLocations) {
                try {
                    const res = await this.sheets.spreadsheets.values.get({
                        spreadsheetId: SPREADSHEET_ID_TECH_CASH,
                        range: `${(loc as any).sheet}!A:Z`,
                        valueRenderOption: 'FORMATTED_VALUE'
                    });
                    processRows(res.data.values, loc);
                } catch (e: any) {
                    logger.error({ err: e.message, location: loc.name, sheet: (loc as any).sheet }, `❌ Error reading TechCash sheet for ${loc.name}`);
                }
            }
        }

        return results;
    }
}

export const techCashService = new TechCashService();
