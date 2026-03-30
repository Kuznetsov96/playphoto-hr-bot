import { locationRepository } from "../repositories/location-repository.js";
import { workShiftRepository } from "../repositories/work-shift-repository.js";
import logger from "../core/logger.js";
import { formatLocationName } from "../handlers/admin/utils.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";

export class ScheduleGapService {
    async findGaps(days: number = 7) {
        const locations = await locationRepository.findAllActive();
        const gaps: { date: Date; locationGaps: { location: any; missing: number }[] }[] = [];

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (let i = 0; i < days; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            
            const nextDay = new Date(date);
            nextDay.setDate(date.getDate() + 1);

            const shifts = await workShiftRepository.findWithRelationsByDateRange(date, nextDay);
            
            const locationGaps: { location: any; missing: number }[] = [];
            const isWeekend = date.getDay() === 0 || date.getDay() === 6; // 0 = Sunday, 6 = Saturday

            for (const loc of locations) {
                const locShifts = shifts.filter(s => s.locationId === loc.id);
                const locNameLower = loc.name.toLowerCase();
                const legacyNameLower = (loc.legacyName || "").toLowerCase();
                
                let needed = 1;
                
                // Specific rules for weekends
                if (isWeekend) {
                    const isDoubleStaffLoc = 
                        locNameLower.includes("smile park") || legacyNameLower.includes("smile park") ||
                        locNameLower.includes("dragon park") || legacyNameLower.includes("dragon park") ||
                        locNameLower.includes("leoland") || legacyNameLower.includes("leoland");
                    
                    if (isDoubleStaffLoc) {
                        needed = 2;
                    }
                }
                
                if (locShifts.length < needed) {
                    locationGaps.push({
                        location: loc,
                        missing: needed - locShifts.length
                    });
                }
            }

            if (locationGaps.length > 0) {
                gaps.push({ date, locationGaps });
            }
        }

        return gaps;
    }

    formatGapReport(gaps: { date: Date; locationGaps: { location: any; missing: number }[] }[]) {
        if (gaps.length === 0) {
            return ADMIN_TEXTS["admin-schedule-gaps-empty"];
        }

        let report = ADMIN_TEXTS["admin-schedule-gaps-title"] + "\n\n";

        for (const dayGap of gaps) {
            const dateStr = dayGap.date.toLocaleDateString("en-US", { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
            report += `📅 <b>${dateStr}:</b>\n`;
            
            for (const locGap of dayGap.locationGaps) {
                const locName = formatLocationName(locGap.location.name, locGap.location.city);
                const missingText = locGap.missing > 1 ? ` (${locGap.missing} missing)` : "";
                report += `• ${locName}${missingText}\n`;
            }
            report += "\n";
        }

        report += ADMIN_TEXTS["admin-schedule-gaps-footer"];
        return report;
    }
}

export const scheduleGapService = new ScheduleGapService();
