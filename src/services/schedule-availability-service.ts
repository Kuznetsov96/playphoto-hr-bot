import { google } from "googleapis";
import path from "path";
import fs from "fs";
import { SPREADSHEET_ID_SCHEDULE, SPREADSHEET_ID_TEAM } from "../config.js";
import { userRepository } from "../repositories/user-repository.js";
import logger from "../core/logger.js";
import { parseScheduleHeaderDate } from "../utils/schedule-sheet-date.js";

export type ScheduleAvailabilityKind = "available" | "limited";

interface TeamMember {
    telegramId: string;
}

export class ScheduleAvailabilityService {
    private sheets: any;
    private readonly availabilityCache = new Map<string, { expiresAt: number; value: Map<string, ScheduleAvailabilityKind> }>();
    private scheduleSheetTitleCache: { expiresAt: number; value: string[] } | null = null;
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
        const cacheKey = `${sheetName}:${this.formatDateKey(date)}`;
        const cached = this.availabilityCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return new Map(cached.value);
        }

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
            ranges: [this.formatA1Range(sheetName)],
            includeGridData: true,
            fields: "sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor,backgroundColorStyle)))))"
        });

        const rowData = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
        const headerValues = rowData[0]?.values || [];
        const targetCol = headerValues.findIndex((cell: any, idx: number) => {
            if (idx === 0 || hiddenColumns.has(idx)) return false;
            const parsed = parseScheduleHeaderDate(String(cell?.formattedValue || ""), sheetName);
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

        this.availabilityCache.set(cacheKey, {
            expiresAt: Date.now() + 60_000,
            value: new Map(availability),
        });
        return availability;
    }

    async getAvailabilityForDateFromSchedule(date: Date): Promise<Map<string, ScheduleAvailabilityKind>> {
        const monthlySheet = await this.findExistingMonthlyScheduleSheetName(date);
        if (monthlySheet) {
            const monthlyAvailability = await this.getAvailabilityForDate(date, monthlySheet).catch((err) => {
                if (this.isTransientGoogleReadError(err)) throw err;
                logger.warn({ err, sheetName: monthlySheet }, "Monthly schedule availability lookup failed");
                return new Map<string, ScheduleAvailabilityKind>();
            });
            if (monthlyAvailability.size > 0) return monthlyAvailability;
        }

        return this.getAvailabilityForDate(date, "Актуальний розклад");
    }

    getMonthlyScheduleSheetName(date: Date): string {
        const kyivDate = new Date(date.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
        return `${this.scheduleSheetMonths[kyivDate.getMonth()]} ${kyivDate.getFullYear()}`;
    }

    private formatDateKey(date: Date) {
        return date.toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    }

    private isTransientGoogleReadError(err: any) {
        const message = String(err?.message || "");
        return err?.status === 429 ||
            err?.code === 429 ||
            message.includes("Quota exceeded") ||
            message.includes("invalid_grant");
    }

    private ensureSheets() {
        if (!this.sheets) throw new Error("Google Sheets not configured (missing google-service-account.json)");
    }

    private async fetchHiddenIndexes(sheetName: string): Promise<{ hiddenRows: Set<number>; hiddenColumns: Set<number> }> {
        const hiddenRows = new Set<number>();
        const hiddenColumns = new Set<number>();

        const res = await this.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID_SCHEDULE,
            ranges: [this.formatA1Range(sheetName)],
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

    private async findExistingMonthlyScheduleSheetName(date: Date): Promise<string | null> {
        const exactName = this.getMonthlyScheduleSheetName(date);
        const monthName = exactName.replace(/\s+\d{4}$/, "");

        const titles = await this.fetchScheduleSheetTitles().catch((err) => {
            if (this.isTransientGoogleReadError(err)) throw err;
            logger.warn({ err, sheetName: exactName }, "Monthly schedule sheet metadata lookup failed");
            return [];
        });

        return this.findSheetTitle(titles, exactName) ?? this.findSheetTitle(titles, monthName);
    }

    private async fetchScheduleSheetTitles(): Promise<string[]> {
        if (this.scheduleSheetTitleCache && this.scheduleSheetTitleCache.expiresAt > Date.now()) {
            return this.scheduleSheetTitleCache.value;
        }

        this.ensureSheets();
        const res = await this.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID_SCHEDULE,
            fields: "sheets(properties(title))"
        });
        const titles = (res.data.sheets || [])
            .map((sheet: any) => String(sheet?.properties?.title || "").trim())
            .filter(Boolean);

        this.scheduleSheetTitleCache = {
            expiresAt: Date.now() + 5 * 60_000,
            value: titles,
        };
        return titles;
    }

    private findSheetTitle(titles: string[], expected: string): string | null {
        const normalizedExpected = this.normalizeSheetTitle(expected);
        return titles.find(title => this.normalizeSheetTitle(title) === normalizedExpected) ?? null;
    }

    private normalizeSheetTitle(title: string): string {
        return title.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
    }

    private formatA1Range(sheetName: string): string {
        return `'${sheetName.replace(/'/g, "''")}'!A1:AL500`;
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
