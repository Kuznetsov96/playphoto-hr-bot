import { existsSync } from "fs";
import { google } from "googleapis";
import path from "path";
import logger from "../core/logger.js";
import { SPREADSHEET_ID_SCHEDULE } from "../config.js";

export interface PreferenceData {
    timestamp: string;      // A: Date and time of filling
    fullNameDot: string;    // B: Surname Name.
    unworkableDays: string; // D: Comma-separated days or "Немає побажань"
    comment: string;        // E: Photographer's comment
}

class PreferencesService {
    private auth: any;
    private sheets: any;
    private spreadsheetId = SPREADSHEET_ID_SCHEDULE;

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
     * Appends preference data to the 'Недоступность' sheet in the schedule spreadsheet.
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

            logger.info({ fullName: data.fullNameDot }, "✅ Preference saved to Google Sheets log");
            return true;
        } catch (error: any) {
            logger.error({ err: error.message, fullName: data.fullNameDot }, "❌ Failed to save preference");
            throw error;
        }
    }
}

export const preferencesService = new PreferencesService();
