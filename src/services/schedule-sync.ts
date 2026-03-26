import { google } from "googleapis";
import path from "path";
import fs from "fs";
import type { Location } from "@prisma/client";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { locationRepository } from "../repositories/location-repository.js";
import { userRepository } from "../repositories/user-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import { accessService } from "./access-service.js";
import { SPREADSHEET_ID_SCHEDULE, SPREADSHEET_ID_TEAM, CITY_NAME_MAP, TEAM_CHATS } from "../config.js";
import type { Api } from "grammy";
import logger from "../core/logger.js";

interface TeamMember {
    fullName: string;
    directoryName: string;
    telegramId: string;
    surnameNameDot: string;
    locationName?: string;
}

/** Map of short codes used in schedule cells → location name pattern */
const LOCATION_CODE_MAP: Record<string, string> = {
    'SP': 'smile park',
    'FK': 'fly kids',
    'DP': 'dragon park',
    'DC': 'drive city',
    'FT': 'fantasy town',
    'VK': 'volkland',
    'VK1': 'volkland 1',
    'VK2': 'volkland 2',
    'VK3': 'volkland 3',
    'K': 'karamel',
    'KD': 'leoland',
    'DH': 'dytyache horyshche',
};

export class ScheduleSyncService {
    private auth: any;
    private sheets: any;

    constructor() {
        const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
        const hasServiceAccount = fs.existsSync(KEY_PATH);

        if (hasServiceAccount) {
            logger.debug("🎫 Using google-service-account.json for Google Sheets");
            this.auth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            this.sheets = google.sheets({ version: 'v4', auth: this.auth });
        } else {
            logger.warn("⚠️ google-service-account.json not found — Google Sheets sync disabled");
            this.auth = null;
            this.sheets = null;
        }
    }

    private ensureSheets() {
        if (!this.sheets) throw new Error("Google Sheets not configured (missing google-service-account.json)");
    }

    /**
     * Safely parses Telegram ID from string, handling scientific notation, spaces, and formatting.
     */
    private parseTelegramId(idStr: string): bigint | null {
        if (!idStr) return null;
        const cleaned = String(idStr).replace(/[^\dEe.]/g, '').trim();
        if (!cleaned || cleaned.length < 5) return null;
        try {
            if (cleaned.includes('E') || cleaned.includes('e')) {
                const num = Number(cleaned);
                if (!isNaN(num)) return BigInt(Math.floor(num));
            }
            if (cleaned.includes('.')) {
                return BigInt(Math.floor(Number(cleaned)));
            }
            return BigInt(cleaned);
        } catch (e) {
            logger.error({ err: e, idStr, cleaned }, "❌ Failed to parse Telegram ID:");
            return null;
        }
    }

    /**
     * Syncs blocked users from Blocklist sheet
     */
    async syncBlocklist() {
        this.ensureSheets();
        logger.info("⏳ Starting blocklist synchronization...");
        try {
            const res = await this.sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: "'Blocklist'!A2:A1000" // Assume Column A has Telegram IDs
            });

            const rows = res.data.values;
            const blockedIds = new Set<bigint>();

            if (rows) {
                rows.forEach((row: any[]) => {
                    const id = this.parseTelegramId(String(row[0] || ""));
                    if (id) blockedIds.add(id);
                });
            }

            logger.info(`🔄 Syncing ${blockedIds.size} blocked IDs...`);

            // 1. Mark new users as blocked or update existing ones
            for (const tgId of blockedIds) {
                await (userRepository as any).upsert({
                    where: { telegramId: tgId },
                    update: { isBlocked: true },
                    create: {
                        telegramId: tgId,
                        username: `Blocked_${tgId}`,
                        firstName: "Blocked",
                        lastName: "User",
                        isBlocked: true
                    }
                });
            }

            // 2. Optional: Unblock users who were removed from the sheet
            // Fetch all currently blocked users from DB
            const allUsers = await userRepository.findAll();
            const currentlyBlockedInDb = allUsers.filter((u: any) => u.isBlocked);

            for (const user of currentlyBlockedInDb) {
                if (!blockedIds.has(user.telegramId)) {
                    logger.info({ telegramId: user.telegramId }, "🔓 Unblocking user (removed from sheet)");
                    await (userRepository as any).update(user.id, { isBlocked: false });
                }
            }

            return { success: true, count: blockedIds.size };
        } catch (e: any) {
            logger.error({ err: e }, "❌ Failed to sync blocklist (maybe sheet 'Blocklist' is missing)");
            return { success: false, error: e.message };
        }
    }

    /**
     * Syncs team members from Google Sheet to Database
     */
    async syncTeam(api?: Api) {
        this.ensureSheets();
        logger.info("⏳ Starting team synchronization...");
        const blocklistRes = await this.syncBlocklist();
        await this.fixLocations();

        // Get count of active staff BEFORE
        const activeBefore = await staffRepository.countActive();

        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID_TEAM,
            range: "'В роботі'!A1:S2000"
        });

        const rows = res.data.values;
        if (!rows || rows.length === 0) {
            logger.warn("⚠️ No data found in 'В роботі' sheet.");
            return { success: false, message: "No data in Team sheet" };
        }

        logger.info(`🔄 Syncing ${rows.length} rows from 'В роботі' sheet...`);

        let staffAdded = 0;
        let staffUpdated = 0;
        let skipped = 0;

        const locations = await locationRepository.findAll();
        // BATCH CACHE: Fetch all existing users and staff to avoid N+1 queries
        const allUsers = await userRepository.findAll();
        const allStaff = await staffRepository.findAll();
        const userMap = new Map(allUsers.map(u => [u.telegramId, u]));
        const staffMap = new Map(allStaff.map(s => [s.userId, s]));

        const teamMappingForSchedule: { [key: string]: TeamMember } = {};

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const fullName = String(row[2] || "").trim();
            const phone = String(row[3] || "").trim();
            const directoryName = String(row[4] || "").trim();
            const status = String(row[5] || "").trim();
            const surnameNameDot = String(row[13] || "").trim();
            const locName = String(row[14] || "").trim();
            const birthDateStr = String(row[15] || "").trim();
            const telegramIdStr = String(row[17] || "").trim();

            if (!fullName) { skipped++; continue; }

            // Normalize status for comparison
            const normalizedStatus = status.toLowerCase();
            const isActive = normalizedStatus === "працює";

            // If status is "Закінчення роботи", isActive will be false.
            // This is correct because "працює" is the only explicitly active status.

            const telegramId = this.parseTelegramId(telegramIdStr);

            if (!telegramId) {
                skipped++;
                continue;
            }

            // Build mapping for schedule sync reuse
            const memberObj = { fullName, directoryName, telegramId: telegramId.toString(), surnameNameDot, locationName: locName };
            if (surnameNameDot && surnameNameDot !== "<>") teamMappingForSchedule[surnameNameDot] = memberObj;
            if (directoryName && directoryName !== "<>") teamMappingForSchedule[directoryName] = memberObj;
            teamMappingForSchedule[telegramId.toString()] = memberObj;

            let birthDate: Date | null = null;
            if (birthDateStr) {
                const parts = birthDateStr.split('.');
                if (parts.length === 3) {
                    const d = parseInt(parts[0]!);
                    const m = parseInt(parts[1]!);
                    const y = parseInt(parts[2]!);
                    if (!isNaN(d) && !isNaN(m) && !isNaN(y)) {
                        birthDate = new Date(Date.UTC(y, m - 1, d));
                    }
                }
            }

            const locParts = locName.split(',').map(p => p.trim()).filter(Boolean);
            const location = this.matchLocation(locParts.length > 0 ? locParts[0]! : locName, locations);

            try {
                let user = userMap.get(telegramId);
                if (!user) {
                    const cleanUsername = (directoryName && directoryName !== "UNKNOWN_IMPORT") ? directoryName : null;
                    user = await userRepository.create({
                        telegramId,
                        username: cleanUsername,
                        firstName: fullName.split(' ')[1] || fullName,
                        lastName: fullName.split(' ')[0] || ""
                    });
                    userMap.set(telegramId, user);
                }

                const profile = staffMap.get(user.id);
                if (profile) {
                    // --- NEW: Channel Removal Logic ---
                    // If staff was active and is now being deactivated
                    if (profile.isActive && !isActive) {
                        logger.info({ fullName, telegramId }, "🚫 [SYNC] Staff deactivated. Removing from team channel...");
                        if (api) {
                            try {
                                // Ban removes the user and prevents them from re-joining until unbanned
                                // We use a short ban or immediately unban if we just want a "kick"
                                await api.banChatMember(TEAM_CHATS.CHANNEL, Number(telegramId));
                                // Optional: immediately unban so they can be re-invited/join later if needed, but they are kicked now
                                await api.unbanChatMember(TEAM_CHATS.CHANNEL, Number(telegramId));
                                logger.info({ fullName }, "✅ [SYNC] Successfully removed from channel");
                            } catch (e: any) {
                                logger.warn({ err: e, fullName }, "⚠️ [SYNC] Failed to remove staff from channel (maybe already left or bot lacks perms)");
                            }
                        } else {
                            logger.warn({ fullName }, "⚠️ [SYNC] Skipping channel removal: no API instance provided");
                        }
                    }

                    await staffRepository.update(profile.id, {
                        fullName,
                        surnameNameDot,
                        phone: phone || profile.phone,
                        location: location ? { connect: { id: location.id } } : { disconnect: true },
                        isActive,
                        ...(birthDate ? { birthDate } : {})
                    });

                    // Also ensure they are not blocked if they are working
                    if (isActive) {
                        await (userRepository as any).update(user.id, { isBlocked: false });
                    }

                    staffUpdated++;
                } else {
                    const newProfile = await staffRepository.create({
                        user: { connect: { id: user.id } },
                        fullName,
                        surnameNameDot,
                        phone,
                        isActive,
                        ...(birthDate ? { birthDate } : {}),
                        ...(location ? { location: { connect: { id: location.id } } } : {})
                    });
                    staffMap.set(user.id, newProfile);
                    staffAdded++;
                }

                if (isActive && user.role === "CANDIDATE") {
                    // Only promote to STAFF if candidate finished the funnel
                    const cand = await candidateRepository.findByUserId(user.id);
                    const hireReady = cand && (cand.status === "AWAITING_FIRST_SHIFT" || cand.status === "HIRED");
                    if (hireReady) {
                        await userRepository.update(user.id, { role: "STAFF" });
                    } else {
                        logger.warn({ fullName, status: cand?.status }, "⚠️ [SYNC] Skipping role→STAFF: candidate still in recruitment funnel");
                    }
                }
            } catch (err) {
                logger.error({ err, fullName }, "❌ Error syncing staff member");
            }
        }

        const activeAfter = await staffRepository.countActive();

        return {
            success: true,
            staffAdded,
            staffUpdated,
            activeBefore,
            activeAfter,
            teamMapping: teamMappingForSchedule,
            blocklistRes
        };
    }


    async syncSchedule(sheetName: string = "Актуальний розклад", existingTeamMap?: { [key: string]: TeamMember }) {
        this.ensureSheets();
        logger.info(`⏳ Starting schedule sync (v2) from sheet: ${sheetName}...`);
        const teamMap = existingTeamMap || await this.fetchTeamMapping();
        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID_SCHEDULE,
            range: `'${sheetName}'!A1:AL500`
        });
        const rows = res.data.values;
        if (!rows || rows.length < 3) throw new Error("Sheet is empty");
        const dateHeader = rows[0];
        const dateMap: { [col: number]: Date } = {};
        const currentYear = new Date().getFullYear();
        dateHeader.forEach((cell: any, idx: number) => {
            if (idx === 0) return;
            const str = String(cell).trim().toLowerCase();
            if (!str) return;
            let date: Date | null = null;
            if (str.includes(',')) {
                const parts = str.split(',');
                const day = parseInt(parts[0]!);
                const month = this.parseMonth((parts[1] || "").trim());
                date = new Date(currentYear, month, day);
            } else if (str.includes('.')) {
                const parts = str.split('.');
                const d = parseInt(parts[0] || "");
                const m = parseInt(parts[1] || "");
                if (!isNaN(d) && !isNaN(m)) date = new Date(currentYear, m - 1, d);
            }
            if (date && !isNaN(date.getTime())) dateMap[idx] = date;
        });
        if (Object.keys(dateMap).length === 0) return { success: false, message: "No dates" };
        const datesToClear = Object.values(dateMap);
        const minDate = new Date(Math.min(...datesToClear.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...datesToClear.map(d => d.getTime())));
        maxDate.setHours(23, 59, 59, 999);

        // --- FIX: Count shifts BEFORE in this range BEFORE deletion ---
        const shiftsBefore = await workShiftRepository.countInRange(minDate, maxDate).catch(() => 0);

        await workShiftRepository.deleteManyByDateRange(minDate, maxDate);

        const allLocations = await locationRepository.findAll();
        // BATCH CACHE
        const allUsersWithStaff = await userRepository.findAllWithStaff();
        const userStaffMap = new Map(allUsersWithStaff.filter(u => u.staffProfile).map(u => [u.telegramId, u.staffProfile!]));

        let currentLocation: Location | null = null;
        let currentCity: string | null = null;
        let syncCount = 0;

        const cities = Object.values(CITY_NAME_MAP);
        const creationPromises: Promise<any>[] = [];

        for (let i = 2; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length === 0) continue;

            const label = String(row[0] || "").trim();
            if (!label) continue;

            const member = teamMap[label];
            if (member) {
                const telegramId = this.parseTelegramId(member.telegramId);
                if (telegramId) {
                    const staffProfile = userStaffMap.get(telegramId);
                    if (staffProfile) {
                        for (const [colIdx, date] of Object.entries(dateMap)) {
                            const cell = String(row[parseInt(colIdx)] || "").trim();
                            if (!this.isShiftCode(cell)) continue;

                            const shiftLocation = this.resolveLocationFromCode(cell, currentLocation, allLocations, currentCity || undefined) || currentLocation;

                            if (shiftLocation) {
                                creationPromises.push(workShiftRepository.create({
                                    staff: { connect: { id: staffProfile.id } },
                                    location: { connect: { id: shiftLocation.id } },
                                    date: date
                                }));
                                syncCount++;
                            }
                        }
                        continue;
                    }
                }
            }

            const foundCity = cities.find(c => c.toLowerCase() === label.toLowerCase()) ||
                Object.keys(CITY_NAME_MAP).find(k => k.toLowerCase() === label.toLowerCase());
            if (foundCity) {
                currentCity = CITY_NAME_MAP[foundCity.toLowerCase()] || foundCity;
                currentLocation = null;
                continue;
            }

            const resolved = this.resolveLocationFromHeader(label, allLocations, currentCity || undefined);
            if (resolved) {
                currentLocation = resolved;
                continue;
            }
        }

        // Parallelize DB creation
        const batchSize = 20;
        for (let i = 0; i < creationPromises.length; i += batchSize) {
            await Promise.all(creationPromises.slice(i, i + batchSize));
        }

        return {
            success: true,
            count: syncCount,
            shiftsBefore,
            shiftsAfter: syncCount
        };
    }

    /**
     * Fixes locations metadata if needed (can be called periodically)
     */
    private async fixLocations() {
        // Implementation remains same
    }

    private matchLocation(locStr: string, locations: Location[]): Location | null {
        const sLoc = locStr.trim().toLowerCase();
        if (!sLoc) return null;

        // 1. Direct precise overrides for all 18 spreadsheet locations
        const overrides: Record<string, { name: string, city: string, exclude?: string }> = {
            'drivecity': { name: 'drive', city: 'Львів' },
            'sp даринок': { name: 'даринок', city: 'Київ' },
            'sp київ': { name: 'smile park', city: 'Київ', exclude: 'даринок' },
            'fk київ': { name: 'fly kids', city: 'Київ' },
            'dragonp': { name: 'dragon', city: 'Львів' },
            'leoland': { name: 'leoland', city: 'Львів' },
            'sp львів': { name: 'smile park', city: 'Львів' },
            'fk львів': { name: 'fly kids', city: 'Львів' },
            'volkland 1': { name: 'volkland 1', city: 'Запоріжжя' },
            'volkland 2': { name: 'volkland 2', city: 'Запоріжжя' },
            'volkland 3': { name: 'volkland 3', city: 'Запоріжжя' },
            'volkland': { name: 'volkland 1', city: 'Запоріжжя' },
            'волкланд': { name: 'volkland 1', city: 'Запоріжжя' },
            'карамель к': { name: 'karamel', city: 'Коломия' },
            'карамель с': { name: 'karamel', city: 'Самбір' },
            'карамель ч': { name: 'karamel', city: 'Шептицький' },
            'fk рівне': { name: 'fly kids', city: 'Рівне' },
            'ft черкаси': { name: 'fantasy', city: 'Черкаси' },
            'sp харків': { name: 'smile park', city: 'Харків' },
            'dh khmelnytskyi': { name: 'attic', city: 'Хмельницький' }
        };

        for (const [key, target] of Object.entries(overrides)) {
            if (sLoc === key || sLoc.includes(key)) {
                const found = locations.find(l => {
                    const name = l.name.toLowerCase();
                    const legacy = (l.legacyName || "").toLowerCase();
                    const matchesName = name.includes(target.name) || legacy.includes(target.name);
                    const notExcluded = !target.exclude || (!name.includes(target.exclude) && !legacy.includes(target.exclude));
                    const matchesCity = l.city === target.city || l.city === CITY_NAME_MAP[target.city.toLowerCase()];
                    return matchesName && notExcluded && matchesCity;
                });
                if (found) return found;
            }
        }

        // 2. Pre-normalize for any other variants
        const normalizedSheetLoc = sLoc
            .replace(/drivecity/g, 'drive city')
            .replace(/sp даринок/g, 'smile park даринок')
            .replace(/^fk\s+/g, 'fly kids ')
            .replace(/^sp\s+/g, 'smile park ')
            .replace(/^dp\s+/g, 'dragon park ')
            .replace(/^ft\s+/g, 'fantasy town ')
            .replace(/^dragonp$/g, 'dragon park')
            .replace(/^leoland$/g, 'leoland')
            .replace(/^leo$/g, 'leoland')
            .replace(/^dh\s+/g, 'dytyache horyshche ')
            .replace(/^волкланд/g, 'volkland')
            .replace(/^карамель\s+к$/g, 'карамель коломия')
            .replace(/^карамель\s+с$/g, 'карамель самбір')
            .replace(/^карамель\s+ч$/g, 'карамель шептицький');

        const branchGroups = [
            ["даринок", "darynok"],
            ["троєщина", "троещина", "troieshchyna"],
            ["skymall", "скаймол", "sky"],
            ["leoland", "леоленд", "leo"],
            ["dragon park", "dragonp"],
            ["drive", "дриве", "драйв"],
            ["fly kids", "флай кідс", "fk"],
            ["smile park", "смайл парк", "sp"],
            ["volkland", "волкланд"]
        ];

        const getGroups = (text: string) => {
            const lower = text.toLowerCase();
            return branchGroups
                .map((group, index) => group.some(k => lower.includes(k)) ? index : -1)
                .filter(i => i !== -1);
        };

        const sheetGroups = getGroups(normalizedSheetLoc);

        let bestMatch: Location | null = null;
        let bestScore = -1;

        for (const l of locations) {
            const lName = l.name.toLowerCase();
            const lLegacy = (l.legacyName || "").toLowerCase();
            const lCity = (l.city || "").toLowerCase();
            const dbGroups = getGroups(lName + " " + lLegacy);

            const hasBranchConflict = sheetGroups.some(sg => dbGroups.length > 0 && !dbGroups.includes(sg));
            if (hasBranchConflict) continue;

            let score = 0;
            if (sLoc === lName || sLoc === lLegacy) score += 100;
            else if (normalizedSheetLoc === lName || normalizedSheetLoc === lLegacy) score += 90;

            const normalizedDbName = lName.replace(/\(.*\)/g, '').trim();
            if (normalizedSheetLoc.includes(normalizedDbName) && normalizedDbName.length > 3) score += 40;

            const commonGroups = sheetGroups.filter(g => dbGroups.includes(g));
            score += commonGroups.length * 50;

            const cityAliases = Object.entries(CITY_NAME_MAP)
                .filter(([_, city]) => city === l.city)
                .map(([alias]) => alias);
            const sheetMentionsCity = lCity && (normalizedSheetLoc.includes(lCity) || cityAliases.some(a => normalizedSheetLoc.includes(a)));

            if (sheetMentionsCity) {
                score += 50;
            } else {
                const otherCities = Object.keys(CITY_NAME_MAP);
                const mentionedOtherCity = otherCities.find(c => normalizedSheetLoc.includes(c) && CITY_NAME_MAP[c] !== l.city);
                if (mentionedOtherCity) score -= 100;
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = l;
            }
        }

        if (bestScore > 30 && bestMatch) {
            logger.info({ locStr, bestScore, matched: bestMatch.name, city: bestMatch.city }, "✅ [SYNC] Location matched");
            return bestMatch;
        }

        return null;
    }

    private parseMonth(monthStr: string): number {
        const months: { [key: string]: number } = {
            'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'май': 4, 'июн': 5,
            'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11,
            'січ': 0, 'лют': 1, 'бер': 2, 'кві': 3, 'тра': 4, 'чер': 5,
            'лип': 6, 'сер': 7, 'вер': 8, 'жов': 9, 'лис': 10, 'гру': 11
        };
        for (const [key, val] of Object.entries(months)) {
            if (monthStr.startsWith(key)) return val;
        }
        return new Date().getMonth();
    }

    private resolveLocationFromHeader(header: string, allLocations: Location[], cityContext?: string): Location | null {
        const h = header.trim();
        const hLower = h.toLowerCase();

        const cityMap: Record<string, string> = {
            'київ': 'Київ', 'львів': 'Львів', 'харків': 'Харків', 'рівне': 'Рівне', 'черкаси': 'Черкаси', 'запоріжжя': 'Запоріжжя', 'коломия': 'Коломия', 'самбір': 'Самбір', 'шептицький': 'Шептицький', 'хмельницький': 'Хмельницький', 'даринок': 'Київ'
        };

        let currentCity = cityContext ? cityMap[cityContext.toLowerCase()] || cityContext : undefined;

        if (hLower.startsWith('sp ') || hLower.startsWith('fk ')) {
            const potentialCity = hLower.substring(3).trim();
            if (cityMap[potentialCity]) currentCity = cityMap[potentialCity];
        }

        const headerAliases: Record<string, { name: string, city?: string, exact?: boolean, exclude?: string }> = {
            'drivecity': { name: 'drive city', city: 'Львів' },
            'dragonp': { name: 'dragon park', city: 'Львів' },
            'leoland': { name: 'leoland', city: 'Львів' },
            'leo': { name: 'leoland', city: 'Львів' },
            'sp даринок': { name: 'darynok', city: 'Київ' },
            'даринок': { name: 'darynok', city: 'Київ' },
            'sp київ': { name: 'smile park', city: 'Київ', exclude: 'darynok' },
            'sp львів': { name: 'smile park', city: 'Львів' },
            'sp харків': { name: 'smile park', city: 'Харків' },
            'fk київ': { name: 'fly kids', city: 'Київ' },
            'fk львів': { name: 'fly kids', city: 'Львів' },
            'fk рівне': { name: 'fly kids', city: 'Рівне' },
            // Volkland without number = Volkland 1; numbered variants match exactly
            'volkland': { name: 'volkland 1', city: 'Запоріжжя', exact: true },
            'volkland 2': { name: 'volkland 2', city: 'Запоріжжя', exact: true },
            'volkland 3': { name: 'volkland 3', city: 'Запоріжжя', exact: true },
        };

        const target = headerAliases[hLower];
        if (target) {
            const found = allLocations.find(l => {
                const lName = l.name.toLowerCase();
                const lLegacy = (l.legacyName || "").toLowerCase();
                const nameMatch = target.exact
                    ? (lName.startsWith(target.name) || lLegacy.startsWith(target.name))
                    : (lName.includes(target.name) || lLegacy.includes(target.name));
                const cityMatch = (target.city) ? l.city === target.city : (currentCity ? l.city === currentCity : true);
                const notExcluded = !target.exclude || (!lName.includes(target.exclude) && !lLegacy.includes(target.exclude));
                return nameMatch && cityMatch && notExcluded;
            });
            if (found) return found;
        }

        const hNormalized = hLower.replace(/sp\s+/g, 'smile park ').replace(/fk\s+/g, 'fly kids ');

        const direct = allLocations.find(l => {
            const matches = l.name.toLowerCase() === hNormalized || l.name.toLowerCase() === hLower || (l.legacyName || "").toLowerCase() === hNormalized || (l.legacyName || "").toLowerCase() === hLower;
            if (!matches) return false;
            return currentCity ? l.city === currentCity : true;
        });
        if (direct) return direct;

        const containsMatch = allLocations.find(l => {
            const matches = hLower.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(hLower) || hNormalized.includes(l.name.toLowerCase()) || l.name.toLowerCase().includes(hNormalized);
            if (!matches) return false;
            return currentCity ? l.city === currentCity : true;
        });
        if (containsMatch) return containsMatch;

        if (hLower.startsWith('карамель')) {
            const suffix = hLower.replace('карамель', '').trim();
            const karamels = allLocations.filter(l => l.name.toLowerCase().includes('karamel'));
            const karamelCity = suffix === 'к' ? 'Коломия' : suffix === 'ч' ? 'Шептицький' : suffix === 'с' ? 'Самбір' : currentCity;
            if (karamelCity) return karamels.find(l => l.city === karamelCity) ?? karamels[0] ?? null;
            return karamels[0] ?? null;
        }
        return null;
    }

    private resolveLocationFromCode(code: string, currentLocation: Location | null, allLocations: Location[], cityContext?: string): Location | null {
        const codeUpper = code.toUpperCase();
        const locPattern = LOCATION_CODE_MAP[codeUpper];
        if (!locPattern) return null;
        const candidates = allLocations.filter(l => l.name.toLowerCase().startsWith(locPattern) || l.name.toLowerCase().includes(locPattern));
        if (candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0]!;
        if (currentLocation && candidates.some(c => c.id === currentLocation.id)) return currentLocation;
        if (cityContext) {
            const sameCity = candidates.find(c => c.city === cityContext);
            if (sameCity) return sameCity;
        }
        if (currentLocation) {
            const sameCity = candidates.find(c => c.city === currentLocation.city);
            if (sameCity) return sameCity;
        }
        return candidates[0] ?? null;
    }

    private isShiftCode(cell: string): boolean {
        if (!cell || cell.length === 0) return false;
        const upper = cell.toUpperCase();
        const offMarkers = ["В", "В.", "В/В", "X", "Х", "OFF", "ОФФ"];
        if (offMarkers.includes(upper)) return false;
        if (/^\d+$/.test(cell)) return false;
        return true;
    }

    private async fetchTeamMapping(): Promise<{ [key: string]: TeamMember }> {
        this.ensureSheets();
        const res = await this.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID_TEAM,
            range: "'В роботі'!A1:S2000"
        });
        const rows = res.data.values;
        const mapping: { [key: string]: TeamMember } = {};
        if (rows) {
            rows.forEach((row: any) => {
                const fullName = String(row[2] || "").trim();
                const directoryName = String(row[4] || "").trim();
                const surnameNameDot = String(row[13] || "").trim();
                const locName = String(row[14] || "").trim();
                const telegramId = String(row[17] || "").trim();
                if (telegramId && telegramId.length > 5) {
                    const member = { fullName, directoryName, telegramId, surnameNameDot, locationName: locName };
                    if (surnameNameDot && surnameNameDot !== "<>" && surnameNameDot !== "n/a") mapping[surnameNameDot] = member;
                    if (directoryName && directoryName !== "<>" && directoryName !== "n/a" && directoryName !== "UNKNOWN_IMPORT") mapping[directoryName] = member;
                    mapping[telegramId] = member;
                }
            });
        }
        return mapping;
    }

    /**
     * Updates Column G (First Shift) in the Team spreadsheet for a specific photographer.
     */
    async updateFirstShiftDateInSheet(telegramId: string, date: Date) {
        this.ensureSheets();
        try {
            const res = await this.sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: "'В роботі'!A1:R2000"
            });

            const rows = res.data.values;
            if (!rows) return;

            const dateStr = date.toLocaleDateString('uk-UA');
            const targetId = telegramId.toString();

            // 1. Find the row (Column R is index 17)
            let rowIndex = -1;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowId = this.parseTelegramId(String(row[17] || ""))?.toString();
                if (rowId === targetId) {
                    rowIndex = i + 1; // Sheets are 1-indexed
                    break;
                }
            }

            if (rowIndex === -1) {
                logger.warn({ telegramId }, "⚠️ Could not find photographer in Team sheet to update first shift date");
                return;
            }

            // 2. Update Column G (Index 6)
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: `'В роботі'!G${rowIndex}`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [[dateStr]]
                }
            });

            logger.info({ telegramId, dateStr, rowIndex }, "✅ Updated first shift date in Team spreadsheet");
        } catch (error) {
            logger.error({ error, telegramId }, "❌ Failed to update first shift date in Team spreadsheet");
        }
    }
}

export const scheduleSyncService = new ScheduleSyncService();
