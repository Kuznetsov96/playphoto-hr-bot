
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";
const t = (key: string, args?: any) => {
    // @ts-ignore
    const text = ADMIN_TEXTS[key] || STAFF_TEXTS[key];
    if (typeof text === 'function') return text(args || {});
    return text || key;
};
import { Bot } from "grammy";
import type { MyContext } from "../types/context.js";
import { userRepository } from "../repositories/user-repository.js";
import { staffRepository } from "../repositories/staff-repository.js";
import { candidateRepository } from "../repositories/candidate-repository.js";
import { locationRepository } from "../repositories/location-repository.js";
import { ADMIN_IDS, CO_FOUNDER_IDS } from "../config.js";
import logger from "../core/logger.js";

function getBirthdayRecipients(): number[] {
    const ids = [...ADMIN_IDS, ...CO_FOUNDER_IDS];
    return [...new Set(ids)];
}

export async function greetCandidateBirthdays(bot: Bot<MyContext>, day: number, month: number) {
    logger.info(`🎂 Greeting candidates with birthday on ${day}/${month}...`);
    const candidates = await candidateRepository.findBirthdaysToday(day, month);
    const { default: prisma } = await import("../db/core.js");
    
    const standardGreeting = `<b>Сьогодні — чудовий привід почати нову главу!</b> ✨\n\n` +
        `Нехай цей рік буде наповнений цікавими відкриттями, творчим натхненням та людьми, які дарують радість. ` +
        `Бажаємо, щоб кожен наступний кадр твого життя був наповнений лише світлими емоціями.\n\n` +
        `З днем народження! 🎈\n` +
        `Команда PlayPhoto`;

    const activationGreeting = `🎂 <b>З днем народження!</b> ✨\n\n` +
        `Нехай цей рік буде наповнений цікавими відкриттями, творчим натхненням та людьми, які дарують радість. ` +
        `Бажаємо, щоб кожен наступний кадр твого життя був наповнений лише світлими емоціями. 🎈\n\n` +
        `<b>Сьогодні тобі виповнилося 17</b>, а це означає, що тепер твій шлях у PlayPhoto може стати реальністю! 📸\n\n` +
        `Ми автоматично повернули твою анкету до списку актуальних. Як тільки на твій локації з'являться вільні місця — ти отримаєш запрошення на співбесіду. Раді, що ти з нами! ✨`;

    let successCount = 0;
    for (const c of candidates) {
        try {
            if (!c.user?.telegramId) continue;

            const tid = Number(c.user.telegramId);
            const birthDate = new Date(c.birthDate!);
            const today = new Date();
            let age = today.getFullYear() - birthDate.getFullYear();
            
            // Check if it's exactly 17th birthday for a previously rejected girl
            const isExactly17 = age === 17;
            const wasUnderage = c.hrDecision === "REJECTED_SYSTEM_UNDERAGE";
            const isFemale = c.gender === "female";

            if (isExactly17 && wasUnderage && isFemale) {
                logger.info({ candidateId: c.id }, "🎈 Candidate turned 17! Activating...");
                
                await prisma.candidate.update({
                    where: { id: c.id },
                    data: {
                        status: "WAITLIST",
                        hrDecision: null,
                        isWaitlisted: true,
                        currentStep: "INTERVIEW",
                        statusChangedAt: new Date()
                    }
                });

                await bot.api.sendMessage(tid, activationGreeting, { parse_mode: "HTML" });
            } else {
                await bot.api.sendMessage(tid, standardGreeting, { parse_mode: "HTML" });
            }
            
            successCount++;
        } catch (e) {
            logger.error({ err: e, candidateId: c.id }, "Failed to send birthday greeting to candidate");
        }
    }

    // Admin Report (English, Silent)
    if (successCount > 0) {
        const mainAdminId = ADMIN_IDS[0];
        if (mainAdminId) {
            const report = `🎂 <b>Candidate Birthdays Report</b>\n\nToday <b>${successCount}</b> candidates were greeted automatically.`;
            try {
                await bot.api.sendMessage(mainAdminId, report, { 
                    parse_mode: "HTML", 
                    disable_notification: true 
                });
            } catch (e) {
                logger.error({ err: e, adminId: mainAdminId }, "Failed to send candidate birthday report to main admin");
            }
        }
    }

    return successCount;
}

export async function checkBirthdays(bot: Bot<MyContext>) {
    logger.info("🎂 Checking birthdays...");
    const now = new Date();

    const getKyivDayMonth = (date: Date) => {
        const s = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' });
        const [d, m] = s.split('/').map(Number);
        return { day: d!, month: m! };
    };

    const today = getKyivDayMonth(now);
    const tomorrow = getKyivDayMonth(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const after3Days = getKyivDayMonth(new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000));

    // 1. Greet candidates (Today only)
    await greetCandidateBirthdays(bot, today.day, today.month);

    // 2. Check staff birthdays (Existing logic for admin alerts)
    const staff = await staffRepository.findActive();

    const todayBday: string[] = [];
    const in1DayBday: string[] = [];
    const in3DaysBday: string[] = [];

    for (const s of staff) {
        if (!s.birthDate) continue;
        const bday = new Date(s.birthDate);
        const bDay = bday.getUTCDate();
        const bMonth = bday.getUTCMonth() + 1;

        const isToday = bDay === today.day && bMonth === today.month;
        const isIn1Day = bDay === tomorrow.day && bMonth === tomorrow.month;
        const isIn3Days = bDay === after3Days.day && bMonth === after3Days.month;

        const user = await userRepository.findById(s.userId);
        const mention = user?.username ? `@${user.username}` : (user?.firstName || "No Name");
        const entry = `• <b>${s.fullName}</b> (${mention})`;

        if (isToday) todayBday.push(entry);
        if (isIn1Day) in1DayBday.push(entry);
        if (isIn3Days) in3DaysBday.push(entry);
    }

    const recipients = getBirthdayRecipients();

    for (const adminId of recipients) {
        try {
            if (in3DaysBday.length > 0) {
                let msg = "🔔 <b>Birthday Reminder</b>\n\nIn 3 days birthday for:\n";
                msg += in3DaysBday.join("\n");
                msg += "\n\nPrepare greetings! 🎈";
                await bot.api.sendMessage(adminId, msg, { parse_mode: "HTML" });
            }

            if (in1DayBday.length > 0) {
                let msg = "🔔 <b>Birthday Reminder</b>\n\nTomorrow birthday for:\n";
                msg += in1DayBday.join("\n");
                msg += "\n\nDon't forget to congratulate! 🎁";
                await bot.api.sendMessage(adminId, msg, { parse_mode: "HTML" });
            }

            if (todayBday.length > 0) {
                let msg = "🎉 <b>Birthday Today!</b>\n\nCongratulations to our photographers:\n";
                msg += todayBday.join("\n");
                msg += "\n\nDon't forget to congratulate! 🥳";
                await bot.api.sendMessage(adminId, msg, { parse_mode: "HTML" });
            }
        } catch (e) {
            logger.error({ err: e, adminId }, "Failed to send birthday alert");
        }
    }
}

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
];

export async function getBirthdaysByMonth(month?: number): Promise<string> {
    const staff = await staffRepository.findActive();

    // Filter by month if provided (1-12), else show all
    const filtered = staff.filter(s => {
        if (!s.birthDate) return false;
        if (month === undefined) return true;
        return new Date(s.birthDate).getMonth() + 1 === month;
    });

    if (filtered.length === 0) {
        const monthName = month ? t(`month-${month}`) : undefined;
        return monthName
            ? t("admin-bday-no-birthdays", { monthName })
            : t("admin-bday-no-staff");
    }

    // Sort by day within month
    filtered.sort((a, b) => {
        const da = new Date(a.birthDate!);
        const db = new Date(b.birthDate!);
        const aVal = (da.getMonth() * 100) + da.getDate();
        const bVal = (db.getMonth() * 100) + db.getDate();
        return aVal - bVal;
    });

    // Group by month
    const grouped: Record<number, string[]> = {};
    for (const s of filtered) {
        const bday = new Date(s.birthDate!);
        const m = bday.getMonth() + 1;
        const day = bday.getDate().toString().padStart(2, "0");
        const mon = m.toString().padStart(2, "0");
        const year = bday.getFullYear();
        const age = new Date().getFullYear() - year;

        const locName = (s.location as any)?.name;
        const locCity = (s.location as any)?.city;
        const locPart = locName ? ` • ${locName}` : (locCity ? ` • ${locCity}` : "");

        if (!grouped[m]) grouped[m] = [];
        grouped[m]!.push(`  ${day}.${mon} — <b>${s.fullName}</b>${locPart} (${age} р.)`);
    }

    const monthName = month ? t(`month-${month}`) : undefined;
    let text = monthName
        ? t("admin-bday-header-month", { monthName }) + "\n\n"
        : t("admin-bday-header-all") + "\n\n";

    for (const m of Object.keys(grouped).map(Number).sort((a, b) => a - b)) {
        if (!month) text += `<b>${t(`month-${m}`)}</b>\n`;
        text += grouped[m]!.join("\n") + "\n";
        if (!month) text += "\n";
    }

    return text;
}

export async function getBirthdaysByLocation(): Promise<string> {
    const staff = await staffRepository.findActive();

    // Group by city -> location
    const grouped: Record<string, Record<string, string[]>> = {};

    for (const s of staff) {
        if (!s.birthDate) continue;

        const bday = new Date(s.birthDate);
        const day = bday.getDate().toString().padStart(2, "0");
        const month = (bday.getMonth() + 1).toString().padStart(2, "0");

        const city = (s.location as any)?.city || "Unknown";
        const locName = (s.location as any)?.name || "Unknown location";

        if (!grouped[city]) grouped[city] = {};
        if (!grouped[city]![locName]) grouped[city]![locName] = [];
        grouped[city]![locName]!.push(`${day}.${month} — ${s.fullName}`);
    }

    if (Object.keys(grouped).length === 0) {
        return "📭 No staff with birth dates.";
    }

    let text = "🎂 <b>Birthdays by location</b>\n\n";

    for (const city of Object.keys(grouped).sort()) {
        text += `🏙️ <b>${city}</b>\n`;
        for (const loc of Object.keys(grouped[city]!).sort()) {
            text += `  📍 <i>${loc}</i>\n`;
            for (const entry of grouped[city]![loc]!.sort()) {
                text += `    • ${entry}\n`;
            }
        }
        text += "\n";
    }

    return text;
}

import { redis } from "../core/redis.js";

export function startBirthdayLoop(bot: Bot<MyContext>) {
    // 1. Run immediate check if not done today
    const runCheck = async () => {
        const todayKey = `bday_checked:${new Date().toLocaleDateString('en-GB', { timeZone: 'Europe/Kyiv' }).replace(/\//g, '-')}`;
        
        // Check if already done today
        const alreadyDone = await redis.get(todayKey);
        if (alreadyDone) {
            logger.info("🎂 Birthday check already performed today, skipping.");
            return;
        }

        try {
            await checkBirthdays(bot);
            // Mark as done for 24h
            await redis.set(todayKey, "true", "EX", 24 * 60 * 60);
        } catch (e) {
            logger.error({ err: e }, "Failed during scheduled birthday check");
        }
    };

    // Run check on startup
    runCheck().catch(e => logger.error({ err: e }, "Failed during initial birthday check"));

    // 2. Schedule next check
    const scheduleNext = () => {
        const now = new Date();
        
        // Use a stable way to calculate delay until 9 AM Kyiv
        const kyivTimeStr = now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" });
        const kyivNow = new Date(kyivTimeStr);
        
        let nextRunKyiv = new Date(kyivNow);
        nextRunKyiv.setHours(9, 0, 0, 0);

        if (kyivNow >= nextRunKyiv) {
            nextRunKyiv.setDate(nextRunKyiv.getDate() + 1);
        }

        const delay = nextRunKyiv.getTime() - kyivNow.getTime();
        
        // For logging, we show the next run time in Kyiv
        logger.info(`🎂 Birthday loop: Next check scheduled at ${nextRunKyiv.getHours().toString().padStart(2, '0')}:${nextRunKyiv.getMinutes().toString().padStart(2, '0')} Kyiv time (in ${Math.round(delay/1000/60)} min)`);

        setTimeout(() => {
            runCheck().finally(() => {
                // After running, schedule the next one
                scheduleNext();
            });
        }, delay);
    };

    scheduleNext();
}
