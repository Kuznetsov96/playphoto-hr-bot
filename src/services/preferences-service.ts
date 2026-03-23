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
     * Saves preference data to the 'Недоступность' sheet.
     * If the photographer already has an entry — overwrites it.
     * Otherwise writes to the first empty row (starting from row 2).
     */
    async savePreference(data: PreferenceData) {
        try {
            const formattedDays = data.unworkableDays.startsWith("'")
                ? data.unworkableDays
                : `'${data.unworkableDays}`;

            const rowData = [data.timestamp, data.fullNameDot, "", formattedDays, data.comment];

            // Read existing data to find photographer or first empty row
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: 'Недоступность!A2:E500',
            });
            const rows: string[][] = response.data.values || [];

            // Find existing row by name (column B = index 1)
            let targetRow = -1;
            let firstEmptyRow = -1;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (row && row[1] && row[1].trim() === data.fullNameDot.trim()) {
                    targetRow = i + 2; // +2 because data starts at row 2
                    break;
                }
                if (firstEmptyRow === -1 && (!row || !row[1])) {
                    firstEmptyRow = i + 2;
                }
            }

            // If not found in existing rows, use first empty row or append after last
            if (targetRow === -1) {
                targetRow = firstEmptyRow !== -1 ? firstEmptyRow : rows.length + 2;
            }

            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range: `Недоступность!A${targetRow}:E${targetRow}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [rowData] },
            });

            logger.info({ fullName: data.fullNameDot, row: targetRow }, "✅ Preference saved to Google Sheets");
            return true;
        } catch (error: any) {
            logger.error({ err: error.message, fullName: data.fullNameDot }, "❌ Failed to save preference");
            throw error;
        }
    }

    /**
     * Checks if a photographer already has preferences in the sheet.
     */
    async hasExistingPreference(fullName: string): Promise<boolean> {
        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: 'Недоступность!B2:B500',
            });
            const rows: string[][] = response.data.values || [];
            return rows.some(row => row[0]?.trim() === fullName.trim());
        } catch {
            return false;
        }
    }
}

export const preferencesService = new PreferencesService();
