import { existsSync } from "fs";
import { google } from "googleapis";
import path from "path";
import logger from "../core/logger.js";
import { SPREADSHEET_ID_TEAM } from "../config.js";

export interface PreferenceData {
    timestamp: string;      // A: Date and time of filling
    fullNameDot: string;    // B: Surname Name. (Col N from employee table)
    unworkableDays: string; // D: Comma-separated days or "Немає побажань за вихідними"
    comment: string;        // E: Photographer's comment
    telegramId?: string;
    monthName?: string;
    logOnly?: boolean;      // If true, only append to log sheet, skip 'В роботі' update
}

class PreferencesService {
    private auth: any;
    private sheets: any;
    private spreadsheetId = SPREADSHEET_ID_TEAM;

    constructor() {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        const hasServiceAccount = existsSync(KEY_PATH);

        if (hasServiceAccount) {
            logger.debug("🎫 Using google-service-account.json for Preferences");
            this.auth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
        } else if (process.env.GOOGLE_REFRESH_TOKEN) {
            logger.debug("🎫 Using GOOGLE_REFRESH_TOKEN (OAuth2) for Preferences");
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
     * Appends preference data to the spreadsheet and updates the main 'В роботі' list.
     */
    async savePreference(data: PreferenceData) {
        try {
            // Add a single quote prefix to prevent Google Sheets from auto-formatting numbers as dates
            const formattedDays = data.unworkableDays.startsWith("'") 
                ? data.unworkableDays 
                : `'${data.unworkableDays}`;

            // --- 1. Save to 'Недоступность' log sheet ---
            const logValues = [[
                data.timestamp,
                data.fullNameDot,
                "", 
                formattedDays,
                data.comment
            ]];

            await this.sheets.spreadsheets.values.append({
                spreadsheetId: this.spreadsheetId,
                range: 'Недоступность!A:E',
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values: logValues },
            });

            // --- 2. Update 'В роботі' sheet (Column S for Current Month, T for Next) ---
            if (data.telegramId && data.monthName && !data.logOnly) {
                const response = await this.sheets.spreadsheets.values.get({
                    spreadsheetId: this.spreadsheetId,
                    range: "'В роботі'!A:R",
                });

                const rows = response.data.values || [];
                let targetRowIndex = -1;

                // Find employee row by Telegram ID (Column R is index 17)
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    if (row && String(row[17]) === String(data.telegramId)) {
                        targetRowIndex = i + 1;
                        break;
                    }
                }

                if (targetRowIndex !== -1) {
                    const now = new Date();
                    const currentMonthName = now.toLocaleString('uk-UA', { month: 'long' });
                    
                    // Determine column: S (index 18) or T (index 19)
                    const isCurrentMonth = data.monthName.toLowerCase() === currentMonthName.toLowerCase();
                    const column = isCurrentMonth ? 'S' : 'T';
                    
                    await this.sheets.spreadsheets.values.update({
                        spreadsheetId: this.spreadsheetId,
                        range: `'В роботі'!${column}${targetRowIndex}`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: { values: [[formattedDays]] },
                    });
                    
                    logger.info({ fullName: data.fullNameDot, month: data.monthName, column }, "✅ Availability updated in 'В роботі' sheet");
                }
            }

            logger.info({ fullName: data.fullNameDot }, "✅ Preference saved to Google Sheets log");
            return true;
        } catch (error: any) {
            logger.error({ err: error.message, fullName: data.fullNameDot }, "❌ Failed to save preference");
            throw error;
        }
    }
}

export const preferencesService = new PreferencesService();
