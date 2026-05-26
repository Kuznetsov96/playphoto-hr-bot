import { google } from "googleapis";
import path from "path";
import fs from "fs";
import { SPREADSHEET_ID_SCHEDULE, SPREADSHEET_ID_TEAM } from "../config.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";

export type ScheduleAvailabilityKind = "available" | "limited";

interface TeamMember {
    telegramId: string;
}

export class ScheduleAvailabilityService {
    private sheets: any;
    private readonly scheduleSheetMonths = [
        "Січень",
        "Лютий",
        "Березень",
        "Квітень",
        "Травень",
        "Червень",
        "Липень",
        "Серпень",
        "Вересень",
        "Жовтень",
        "Листопад",
        "Грудень",
    ];

    constructor() {
        const keyPath = path.join(process.cwd(), "google-service-account.json");
        if (!fs.existsSync(keyPath)) {
            logger.warn("Schedule availability disabled because service account file is missing");
            this.sheets = null;
            return;
        }

        const auth = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        this.sheets = google.sheets({ version: "v4", auth });
    }

    async getAvailabilityForDate(date: Date, sheetName: string = "Актуальний розклад"): Promise<Map<string, ScheduleAvailabilityKind>> {
        this.ensureSheets();
        const [teamMap, { hiddenRows, hiddenColumns }, allUsersWithStaff] = await Promise.all([
            this.fetchTeamMapping(),
            this.fetchHiddenIndexes(sheetName),
            userRepository.findAllWithStaff()
        ]);
        const userStaffMap = new Map(
            allUsersWithStaff
                .filter(u => u.staffProfile)
                .map(u => [u.telegramId.toString(), u.staffProfile!])
        );

        const res = await this.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID_SCHEDULE,
            ranges: [`'${sheetName}'!A1:AL500`],
            includeGridData: true,
            fields: "sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor,backgroundColorStyle)))))"
        });

        const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
        const headerValues = rowData[0]?.values || [];
        const targetCol = headerValues.findIndex((cell: any, idx: number) => {
            if (idx === 0 || hiddenColumns.has(idx)) return false;
            const parsed = this.parseScheduleHeaderDate(String(cell?.formattedValue || ""));
            return parsed ? this.isSameKyivDay(parsed, date) : false;
        });

        if (targetCol < 0) return new Map();

        const availability = new Map<string, ScheduleAvailabilityKind>();
        for (let i = 2; i < rowData.length; i++) {
            if (hiddenRows.has(i)) continue;

            const values = rowData[i]?.values || [];
            const label = String(values[0]?.formattedValue || "").trim();
            if (!label) continue;

            const member = teamMap[label];
            if (!member) continue;

            const telegramId = this.parseTelegramId(member.telegramId);
            if (!telegramId) continue;

            const staffProfile = userStaffMap.get(telegramId.toString());
            if (!staffProfile) continue;

            availability.set(
                staffProfile.id,
                this.cellHasVisibleFill(values[targetCol]) ? "limited" : "available"
            );
        }

        return availability;
    }

    getMonthlyScheduleSheetName(date: Date): string {
        const kyivDate = new Date(date.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        return `${this.scheduleSheetMonths[kyivDate.getMonth()]} ${kyivDate.getFullYear()}`;
    }

    private ensureSheets() {
        if (!this.sheets) throw new Error("Google Sheets not configured (missing google-service-account.json)");
    }

    private async fetchHiddenIndexes(sheetName: string): Promise<{ hiddenRows: Set<number>; hiddenColumns: Set<number> }> {
        const hiddenRows = new Set<number>();
        const hiddenColumns = new Set<number>();

        const res = await this.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID_SCHEDULE,
            ranges: [`'${sheetName}'!A1:AL500`],
            includeGridData: true,
            fields: "sheets(properties(title),data(rowMetadata(hiddenByFilter,hiddenByUser),columnMetadata(hiddenByFilter,hiddenByUser)))"
        });

        const gridData = res.data.sheets?.[0]?.data?.[0];
        gridData?.rowMetadata?.forEach((metadata: any, index: number) => {
            if (metadata?.hiddenByFilter || metadata?.hiddenByUser) hiddenRows.add(index);
        });
        gridData?.columnMetadata?.forEach((metadata: any, index: number) => {
            if (metadata?.hiddenByFilter || metadata?.hiddenByUser) hiddenColumns.add(index);
        });

        return { hiddenRows, hiddenColumns };
    }

    private async fetchTeamMapping(): Promise<Record<string, TeamMember>> {
        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID_TEAM,
            range: "'В роботі'!A1:S2000"
        });
        const mapping: Record<string, TeamMember> = {};
        for (const row of res.data.values || []) {
            const status = String(row[5] || "").trim().toLowerCase();
            const directoryName = String(row[4] || "").trim();
            const surnameNameDot = String(row[13] || "").trim();
            const telegramId = String(row[17] || "").trim();
            if (status !== "працює" || !telegramId || telegramId.length <= 5) continue;

            const member = { telegramId };
            if (surnameNameDot && surnameNameDot !== "<>" && surnameNameDot !== "n/a") mapping[surnameNameDot] = member;
            if (directoryName && directoryName !== "<>" && directoryName !== "n/a" && directoryName !== "UNKNOWN_IMPORT") mapping[directoryName] = member;
            mapping[telegramId] = member;
        }
        return mapping;
    }

    private parseTelegramId(idStr: string): bigint | null {
        const cleaned = String(idStr).replace(/[^\dEe.]/g, "").trim();
        if (!cleaned || cleaned.length < 5) return null;
        try {
            if (cleaned.includes("E") || cleaned.includes("e") || cleaned.includes(".")) {
                const num = Number(cleaned);
                return Number.isNaN(num) ? null : BigInt(Math.floor(num));
            }
            return BigInt(cleaned);
        } catch {
            return null;
        }
    }

    private parseMonth(monthStr: string): number {
        const months: Record<string, number> = {
            "янв": 0, "фев": 1, "мар": 2, "апр": 3, "май": 4, "июн": 5,
            "июл": 6, "авг": 7, "сен": 8, "окт": 9, "ноя": 10, "дек": 11,
            "січ": 0, "лют": 1, "бер": 2, "кві": 3, "тра": 4, "чер": 5,
            "лип": 6, "сер": 7, "вер": 8, "жов": 9, "лис": 10, "гру": 11
        };
        for (const [key, val] of Object.entries(months)) {
            if (monthStr.startsWith(key)) return val;
        }
        return new Date().getMonth();
    }

    private parseScheduleHeaderDate(value: string): Date | null {
        const str = value.trim().toLowerCase();
        if (!str) return null;

        const currentYear = new Date().getFullYear();
        if (str.includes(",")) {
            const parts = str.split(",");
            const day = parseInt(parts[0] || "");
            const month = this.parseMonth((parts[1] || "").trim());
            if (!isNaN(day)) return new Date(currentYear, month, day);
        }

        if (str.includes(".")) {
            const parts = str.split(".");
            const day = parseInt(parts[0] || "");
            const month = parseInt(parts[1] || "");
            if (!isNaN(day) && !isNaN(month)) return new Date(currentYear, month - 1, day);
        }

        return null;
    }

    private isSameKyivDay(left: Date, right: Date): boolean {
        return left.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }) ===
            right.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    }

    private cellHasVisibleFill(cell: any): boolean {
        const color = cell?.effectiveFormat?.backgroundColor;
        const styleColor = cell?.effectiveFormat?.backgroundColorStyle?.rgbColor;
        const selected = styleColor || color;
        if (!selected) return false;

        const red = selected.red ?? 0;
        const green = selected.green ?? 0;
        const blue = selected.blue ?? 0;

        return !(red >= 0.98 && green >= 0.98 && blue >= 0.98);
    }
}

export const scheduleAvailabilityService = new ScheduleAvailabilityService();
