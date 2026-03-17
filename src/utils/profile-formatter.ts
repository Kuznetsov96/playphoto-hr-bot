import type { Candidate, User, Location } from "@prisma/client";
import { getPriorityLabel } from "./location-helpers.js";
import { shortenName } from "./string-utils.js";
import { ADMIN_TEXTS } from "../constants/admin-texts.js";
import { STAFF_TEXTS } from "../constants/staff-texts.js";

export interface ProfileFormatOptions {
    locale?: string;
    includeActionLabel?: boolean;
    actionLabel?: string;
    interviewSlot?: any;
    includeHistory?: boolean;
    viewerRole?: "HR" | "MENTOR";
}

const CITY_TO_EN: Record<string, string> = {
    'Київ': 'Kyiv',
    'Львів': 'Lviv',
    'Харків': 'Kharkiv',
    'Рівне': 'Rivne',
    'Черкаси': 'Cherkasy',
    'Запоріжжя': 'Zaporizhzhia',
    'Коломия': 'Kolomyia',
    'Самбір': 'Sambir',
    'Шептицький': 'Sheptytskyi',
    'Хмельницький': 'Khmelnytskyi'
};

// New Final Step Pipeline statuses
const FINAL_STEP_STATUSES = ["NDA", "KNOWLEDGE_TEST", "STAGING_SETUP", "STAGING_ACTIVE", "READY_FOR_HIRE"];
const OLD_STAGING_STATUSES = ["OFFLINE_STAGING", "AWAITING_FIRST_SHIFT", "HIRED"];

export async function formatCandidateProfile(
    ctx: any,
    candidate: any,
    options: ProfileFormatOptions
): Promise<string> {
    const { includeActionLabel, actionLabel, interviewSlot } = options;

    const t = (key: string, args?: any) => {
        // @ts-ignore
        const text = ADMIN_TEXTS[key] || STAFF_TEXTS[key];
        if (typeof text === 'function') return text(args || {});
        return text || key;
    };

    const rawCity = candidate.city || candidate.location?.city || "";
    const city = CITY_TO_EN[rawCity] || rawCity;
    const status: string = candidate.status;

    const isFinalStep = FINAL_STEP_STATUSES.includes(status);
    const isOldStaging = OLD_STAGING_STATUSES.includes(status);
    const isTrainingStage = ["TRAINING_SCHEDULED", "TRAINING_COMPLETED", "DISCOVERY_SCHEDULED", "DISCOVERY_COMPLETED"].includes(status);
    const isPastHR = isFinalStep || isOldStaging || isTrainingStage;

    // ── SECTION 1: IDENTITY ──────────────────────────────────────────────
    const displayName = shortenName(candidate.fullName);
    let text = `👤 <b>${displayName || t('admin-search-no-name')}</b>\n`;

    let locationInfo = city;
    if (candidate.location?.name && candidate.location.name !== rawCity && candidate.location.name !== city) {
        locationInfo = city ? `${city} • ${candidate.location.name}` : candidate.location.name;
    }
    if (locationInfo) text += `📍 ${locationInfo}\n`;

    const username = candidate.user?.username;
    if (username && username.length < 32 && !username.includes('/') && !username.includes('\\')) {
        text += `📱 @${username}\n`;
    }

    // ── SECTION 2: HR SELECTION STAGE ────────────────────────────────────
    if (!isPastHR) {
        if (candidate.status === "MANUAL_REVIEW" && candidate.appearance) {
            text += `\n💍 ${candidate.appearance}\n`;
        }

        if (candidate.hrDecision && candidate.status !== "WAITLIST" && options.viewerRole !== "MENTOR") {
            const dec = candidate.hrDecision === "ACCEPTED" ? "✅" : "❌";
            const notif = candidate.notificationSent ? "" : " (⏳)";
            text += `\n${dec} <b>${candidate.hrDecision}</b>${notif}\n`;
        }

        if (interviewSlot) {
            const slotTime = new Date(interviewSlot.startTime).toLocaleString('uk-UA', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv'
            });
            text += `\n🗓 <b>${slotTime}</b>\n`;
        } else if (!candidate.hrDecision && !["MANUAL_REVIEW", "SCREENING"].includes(status)) {
            if (options.viewerRole !== "MENTOR") {
                const statusLabel = t(`status-${status}`);
                text += `📊 <code>${statusLabel}</code>\n`;
            }
        }
    }

    // ── SECTION 3: TRAINING / DISCOVERY ──────────────────────────────────
    if (isTrainingStage && !isOldStaging) {
        const isDiscovery = ["DISCOVERY_SCHEDULED", "DISCOVERY_COMPLETED"].includes(status);
        const header = isDiscovery ? `🤝 <b>DISCOVERY</b>` : `💻 <b>ONLINE TRAINING</b>`;
        text += `\n${header}\n`;

        if (status === "TRAINING_COMPLETED" || status === "DISCOVERY_COMPLETED") {
            text += `🎓 Status: <b>Completed</b>\n`;
        } else {
            const slot = candidate.trainingSlot || candidate.discoverySlot;
            if (slot) {
                const trainingTime = new Date(slot.startTime).toLocaleString('uk-UA', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv'
                }).replace(',', ' •');
                text += `📅 Session: <b>${trainingTime}</b>\n`;
            } else {
                text += `Materials: ${candidate.materialsSent ? "Sent 📩" : "Not sent ⏳"}\n`;
            }
        }
    }

    // ── SECTION 4: FINAL STEP PIPELINE (new statuses) ────────────────────
    if (isFinalStep) {
        const FINAL_LABELS: Record<string, string> = {
            NDA:            "📑 NDA",
            KNOWLEDGE_TEST: "📝 Knowledge Test",
            STAGING_SETUP:  "📸 Staging Setup",
            STAGING_ACTIVE: "⌛ Active Staging",
            READY_FOR_HIRE: "✅ Ready for Hire",
        };
        text += `\n${FINAL_LABELS[status] || status}\n`;

        // Staging details
        if (["STAGING_SETUP", "STAGING_ACTIVE"].includes(status)) {
            if (candidate.firstShiftDate) {
                const dateStr = new Date(candidate.firstShiftDate).toLocaleDateString('uk-UA', {
                    day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv'
                });
                text += `📅 Date: <b>${dateStr}</b>`;
                if (candidate.firstShiftTime) text += ` • <b>${candidate.firstShiftTime}</b>`;
                text += `\n`;
            } else {
                text += `📅 Date: <i>not set</i>\n`;
            }

            const partnerName = candidate.firstShiftPartner?.fullName;
            if (partnerName) {
                text += `📸 Partner: <b>${shortenName(partnerName)}</b>\n`;
            } else {
                text += `📸 Partner: <i>not set</i>\n`;
            }
        }

        if (status === "NDA") {
            const ndaStatus = candidate.ndaConfirmedAt ? "✅ Confirmed" : "⏳ Pending";
            text += `NDA: ${ndaStatus}\n`;
        }
    }

    // ── SECTION 5: OLD STAGING / ONBOARDING ──────────────────────────────
    if (isOldStaging && candidate.firstShiftDate) {
        const header = status === "HIRED" ? `🚀 <b>ONBOARDING</b>` : `📸 <b>OFFLINE STAGING</b>`;
        text += `\n${header}\n`;

        if (candidate.quizScore !== null && candidate.quizScore !== undefined) {
            text += `Test: <b>${candidate.quizScore}/53</b>\n`;
        }

        const shiftDate = new Date(candidate.firstShiftDate);
        const stagingDate = shiftDate.toLocaleDateString('uk-UA', {
            day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv'
        });

        let shiftTime = candidate.firstShiftTime;
        if (!shiftTime && candidate.location?.schedule) {
            const schedule = candidate.location.schedule;
            const isWeekend = [0, 6].includes(shiftDate.getDay());
            const match = isWeekend
                ? schedule.match(/Сб-Нд\s*[—-]\s*(\d{2}:\d{2}[—-]\d{2}:\d{2})/i)
                : schedule.match(/Пн-Пт\s*[—-]\s*(\d{2}:\d{2}[—-]\d{2}:\d{2})/i);
            if (match) shiftTime = match[1];
        }

        text += `Date: <b>${stagingDate}</b>`;
        if (shiftTime) text += ` • <b>${shiftTime}</b>`;
        text += `\n`;
    }

    // ── SECTION 6: MESSAGE HISTORY (inbox only) ───────────────────────────
    if (options.includeHistory) {
        const { messageRepository } = await import("../repositories/message-repository.js");
        const { cryptoUtility } = await import("../core/crypto.js");
        const scope = options.viewerRole || "HR";
        const history = await messageRepository.findByCandidateIdAndScope(candidate.id, scope);
        const last7 = history.slice(0, 7).reverse();

        if (last7.length > 0) {
            text += `\n📜 <b>History Preview:</b>\n`;
            for (const msg of last7) {
                const time = msg.createdAt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                const icon = msg.sender === "USER" ? "📥" : "📤";
                const decryptedContent = cryptoUtility.decrypt(msg.content);
                const content = decryptedContent && decryptedContent.length > 60
                    ? decryptedContent.substring(0, 57) + "..."
                    : decryptedContent;
                text += `${icon} <i>${time}:</i> ${content || "[Media]"}\n`;
            }
        }
    }

    if (includeActionLabel) {
        text += `\n${actionLabel || t('admin-profile-select-action')}`;
    }

    return text;
}
