import { existsSync } from "fs";
import { google } from "googleapis";
import path from "path";
import logger from "../core/logger.js";
import { SPREADSHEET_ID_TEAM } from "../config.js";

export interface TeamMemberData {
    fullName: string;
    phone: string;
    email: string;
    telegramId: string;
    username: string;
    instagram: string;
    iban: string;
    city: string;
    locationName: string;
    birthDate?: Date | string | null;
}

class TeamRegistrationService {
    private auth: any;
    private sheets: any;

    constructor() {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        const hasServiceAccount = existsSync(KEY_PATH);

        if (hasServiceAccount) {
            logger.debug("🎫 Using google-service-account.json for Team Registration");
            this.auth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
        } else if (process.env.GOOGLE_REFRESH_TOKEN) {
            logger.debug("🎫 Using GOOGLE_REFRESH_TOKEN (OAuth2) for Team Registration");
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
     * Formats Surname Name -> Surname N.
     */
    private formatSurnameInitial(fullName: string): string {
        if (!fullName || fullName === "—") return "";
        
        // Clean up double spaces and trim
        const cleanName = fullName.replace(/\s+/g, ' ').trim();
        const parts = cleanName.split(' ');
        
        if (parts.length < 2) return cleanName;
        
        const surname = parts[0];
        const firstName = parts[1];
        
        if (!surname || !firstName || !firstName[0]) return cleanName;
        
        // Return "Surname F." (e.g. "Kuznetsov V.")
        return `${surname} ${firstName[0].toUpperCase()}.`;
    }

    /**
     * Maps DB location name to the specific short code used in the Google Sheet.
     * Uses exact capitalization found in the sheet.
     */
    private formatLocationForSheet(locationName: string, city: string): string {
        const name = locationName.toLowerCase();
        const c = city.toLowerCase();

        if (name.includes("khmelnytskyi") || name.includes("хмельницький") || name.includes("горище") || name.includes("horyshche") || name.startsWith("dh ")) return "DH Khmelnytskyi";
        if (name.includes("drive")) return "DriveCity";
        if (name.includes("даринок")) return "SP Даринок";
        
        if (name.includes("smile park") || name.startsWith("sp ")) {
            if (c.includes("львів")) return "SP Львів";
            if (c.includes("харків")) return "SP Харків";
            return "SP Київ";
        }
        
        if (name.includes("fly kids") || name.startsWith("fk ")) {
            if (c.includes("львів")) return "FK Львів";
            if (c.includes("рівне")) return "FK Рівне";
            return "FK Київ";
        }
        
        if (name.includes("dragon")) return "DragonP";
        if (name.includes("leoland")) return "Leoland";
        
        if (name.includes("volkland")) {
            if (name.includes("2")) return "Volkland 2";
            if (name.includes("3")) return "Volkland 3";
            return "Volkland";
        }
        
        if (name.includes("karamel") || name.includes("карамель")) {
            if (c.includes("коломия")) return "Карамель К";
            if (c.includes("самбір")) return "Карамель С";
            return "Карамель Ч";
        }
        
        if (name.includes("fantasy") || name.includes("town") || name.startsWith("ft ")) return "FT Черкаси";

        return locationName || city;
    }

    /**
     * Adds a new hire to the 'В роботі' sheet.
     */
    async registerNewHire(data: TeamMemberData) {
        try {
            const timestamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
            const sheetLocation = this.formatLocationForSheet(data.locationName, data.city);
            const directoryName = this.formatSurnameInitial(data.fullName);
            
            let birthDateStr = "—";
            if (data.birthDate) {
                const bd = new Date(data.birthDate);
                if (!isNaN(bd.getTime())) {
                    birthDateStr = bd.toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' });
                }
            }
            
            const values = [[
                timestamp, // A: Дата переносу
                data.city || "—", // B: Місто
                String(data.fullName || "—"), // C: ПІБ
                String(data.phone || "—"), // D: Контакт
                String(data.username || "—"), // E: Telegram Username
                "Працює", // F: Статус (Змінено за запитом)
                "", // G: Дата початку роботи
                "", // H: NDA підписано
                `Instagram: ${data.instagram || '—'}\nIBAN: ${data.iban || '—'}\nEmail: ${data.email || '—'}`, // I: Коментарі
                "", // J
                "", // K
                "", // L
                "", // M
                directoryName, // N: Прізвище І.
                String(sheetLocation || "—"), // O: Локація
                birthDateStr, // P: Дата народження
                "", // Q
                String(data.telegramId || "—") // R: Telegram ID
            ]];

            // 1. Insert an empty row at index 1 (Row 2)
            await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                requestBody: {
                    requests: [
                        {
                            insertDimension: {
                                range: {
                                    sheetId: 2058398570, // GID for 'В роботі'
                                    dimension: "ROWS",
                                    startIndex: 1, // After header (row 1 is index 0)
                                    endIndex: 2
                                },
                                inheritFromBefore: false
                            }
                        }
                    ]
                }
            });

            // 2. Update the newly created row with values
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: "'В роботі'!A2:R2",
                valueInputOption: "USER_ENTERED",
                requestBody: { values }
            });

            logger.info({ 
                fullName: data.fullName, 
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: "'В роботі'!A2:R2"
            }, "✅ New hire registered at the TOP of Google Sheets (TEAM)");
            return true;
        } catch (error: any) {
            logger.error({ 
                err: error.message, 
                fullName: data.fullName, 
                spreadsheetId: SPREADSHEET_ID_TEAM,
                stack: error.stack,
                details: error.response?.data,
                authType: process.env.GOOGLE_REFRESH_TOKEN ? "OAuth2" : "ServiceAccount"
            }, "❌ Failed to register new hire in Google Sheets");
            throw error;
        }
    }
}

export const teamRegistrationService = new TeamRegistrationService();
