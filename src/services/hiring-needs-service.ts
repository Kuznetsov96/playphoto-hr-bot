import { CandidateStatus, FunnelStep } from "@prisma/client";
import prisma from "../db/core.js";
import { systemStateRepository } from "../repositories/system-state-repository.js";
import { getCityCode, getShortLocationName } from "../utils/location-helpers.js";

export type HiringUrgency = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

type HiringNeedMeta = {
    urgency?: HiringUrgency;
    deadline?: string;
    note?: string;
    updatedAt?: string;
};

type HiringNeedMetaState = Record<string, HiringNeedMeta>;

export type HiringNeedItem = {
    locationId: string;
    locationName: string;
    city: string;
    needed: number;
    hrPool: number;
    mentorPool: number;
    finalPool: number;
    reservedFirstShift: number;
    hired7d: number;
    gap: number;
    urgency: HiringUrgency;
    overrideUrgency: HiringUrgency | null;
    deadline: string | null;
    note: string | null;
};

export type HiringNeedsBoard = {
    totals: {
        locations: number;
        withDemand: number;
        critical: number;
        high: number;
        normal: number;
        low: number;
        totalNeed: number;
        totalGap: number;
    };
    items: HiringNeedItem[];
};

const META_KEY = "hiring-needs-meta:v1";

const HR_POOL_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.SCREENING,
    CandidateStatus.WAITLIST,
    CandidateStatus.WAITLIST_HR,
    CandidateStatus.INTERVIEW_SCHEDULED,
    CandidateStatus.INTERVIEW_COMPLETED,
    CandidateStatus.DECISION_PENDING,
    CandidateStatus.ACCEPTED,
]);

const MENTOR_POOL_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.WAITLIST_MENTOR,
    CandidateStatus.DISCOVERY_SCHEDULED,
    CandidateStatus.DISCOVERY_COMPLETED,
    CandidateStatus.TRAINING_SCHEDULED,
    CandidateStatus.TRAINING_COMPLETED,
]);

const FINAL_POOL_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.NDA,
    CandidateStatus.KNOWLEDGE_TEST,
    CandidateStatus.STAGING_SETUP,
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
]);

const RESERVED_FIRST_SHIFT_STATUSES = new Set<CandidateStatus>([
    CandidateStatus.STAGING_ACTIVE,
    CandidateStatus.OFFLINE_STAGING,
    CandidateStatus.READY_FOR_HIRE,
    CandidateStatus.AWAITING_FIRST_SHIFT,
]);

function urgencyWeight(urgency: HiringUrgency): number {
    switch (urgency) {
        case "CRITICAL":
            return 4;
        case "HIGH":
            return 3;
        case "NORMAL":
            return 2;
        case "LOW":
        default:
            return 1;
    }
}

function urgencyIcon(urgency: HiringUrgency): string {
    switch (urgency) {
        case "CRITICAL":
            return "🔴";
        case "HIGH":
            return "🟠";
        case "NORMAL":
            return "🟡";
        case "LOW":
        default:
            return "🟢";
    }
}

function urgencyLabel(urgency: HiringUrgency): string {
    switch (urgency) {
        case "CRITICAL":
            return "Critical";
        case "HIGH":
            return "High";
        case "NORMAL":
            return "Normal";
        case "LOW":
        default:
            return "Low";
    }
}

function deriveUrgency(needed: number, gap: number): HiringUrgency {
    if (gap >= 3 || needed >= 4) return "CRITICAL";
    if (gap >= 2 || needed >= 2) return "HIGH";
    if (gap >= 1 || needed >= 1) return "NORMAL";
    return "LOW";
}

async function readMetaState(): Promise<HiringNeedMetaState> {
    const raw = await systemStateRepository.get(META_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as HiringNeedMetaState;
        if (!parsed || typeof parsed !== "object") return {};
        return parsed;
    } catch {
        return {};
    }
}

async function writeMetaState(state: HiringNeedMetaState): Promise<void> {
    await systemStateRepository.set(META_KEY, JSON.stringify(state));
}

export const hiringNeedsService = {
    async getBoard(): Promise<HiringNeedsBoard> {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [locations, candidates, metaState] = await Promise.all([
            prisma.location.findMany({
                where: { isHidden: false },
                select: { id: true, name: true, city: true, neededCount: true }
            }),
            prisma.candidate.findMany({
                where: { locationId: { not: null } },
                select: {
                    locationId: true,
                    status: true,
                    statusChangedAt: true,
                    firstShiftDate: true,
                    isWaitlisted: true,
                    currentStep: true,
                    user: { select: { botBlockedAt: true } }
                }
            }),
            readMetaState()
        ]);

        const byLocation = new Map<string, HiringNeedItem>();
        for (const location of locations) {
            const meta = metaState[location.id] || {};
            const needed = Math.max(0, location.neededCount || 0);
            byLocation.set(location.id, {
                locationId: location.id,
                locationName: location.name,
                city: location.city,
                needed,
                hrPool: 0,
                mentorPool: 0,
                finalPool: 0,
                reservedFirstShift: 0,
                hired7d: 0,
                gap: needed,
                urgency: "LOW",
                overrideUrgency: meta.urgency || null,
                deadline: meta.deadline || null,
                note: meta.note || null
            });
        }

        for (const candidate of candidates) {
            const locationId = candidate.locationId || "";
            const row = byLocation.get(locationId);
            if (!row) continue;
            if (candidate.user.botBlockedAt) continue;

            if (candidate.status === CandidateStatus.HIRED) {
                if (candidate.statusChangedAt && candidate.statusChangedAt >= weekAgo) {
                    row.hired7d++;
                }
                continue;
            }

            if (HR_POOL_STATUSES.has(candidate.status)) {
                row.hrPool++;
            }
            if (MENTOR_POOL_STATUSES.has(candidate.status)) {
                row.mentorPool++;
            }
            if (FINAL_POOL_STATUSES.has(candidate.status)) {
                row.finalPool++;
            }

            if (
                RESERVED_FIRST_SHIFT_STATUSES.has(candidate.status) &&
                candidate.firstShiftDate &&
                candidate.currentStep === FunnelStep.FIRST_SHIFT
            ) {
                row.reservedFirstShift++;
            }
        }

        const items = Array.from(byLocation.values()).map((row) => {
            row.gap = Math.max(0, row.needed - row.reservedFirstShift);
            row.urgency = row.overrideUrgency || deriveUrgency(row.needed, row.gap);
            return row;
        }).filter((row) =>
            row.needed > 0 ||
            row.hrPool > 0 ||
            row.mentorPool > 0 ||
            row.finalPool > 0 ||
            row.reservedFirstShift > 0
        );

        items.sort((a, b) => {
            const urgencyDiff = urgencyWeight(b.urgency) - urgencyWeight(a.urgency);
            if (urgencyDiff !== 0) return urgencyDiff;
            if (b.gap !== a.gap) return b.gap - a.gap;
            if (b.needed !== a.needed) return b.needed - a.needed;
            return `${a.city}-${a.locationName}`.localeCompare(`${b.city}-${b.locationName}`);
        });

        const totals = {
            locations: locations.length,
            withDemand: items.filter((item) => item.needed > 0).length,
            critical: items.filter((item) => item.urgency === "CRITICAL").length,
            high: items.filter((item) => item.urgency === "HIGH").length,
            normal: items.filter((item) => item.urgency === "NORMAL").length,
            low: items.filter((item) => item.urgency === "LOW").length,
            totalNeed: items.reduce((acc, item) => acc + item.needed, 0),
            totalGap: items.reduce((acc, item) => acc + item.gap, 0),
        };

        return { totals, items };
    },

    formatBoardText(board: HiringNeedsBoard, role: "HR" | "MENTOR" | "ADMIN"): string {
        const header = role === "ADMIN"
            ? "Hiring Needs Board (Admin)"
            : role === "MENTOR"
                ? "Hiring Needs Board (Mentor)"
                : "Hiring Needs Board (HR)";

        const lines: string[] = [];
        lines.push(`🎯 <b>${header}</b>`);
        lines.push("");
        lines.push(`Locations with demand: <b>${board.totals.withDemand}</b> / ${board.totals.locations}`);
        lines.push(`Need: <b>${board.totals.totalNeed}</b> | Operational gap: <b>${board.totals.totalGap}</b>`);
        lines.push(`Critical: <b>${board.totals.critical}</b> | High: <b>${board.totals.high}</b> | Normal: <b>${board.totals.normal}</b>`);
        lines.push("");

        if (board.items.length === 0) {
            lines.push("No active hiring demand right now.");
            return lines.join("\n");
        }

        for (const item of board.items.slice(0, 14)) {
            const icon = urgencyIcon(item.urgency);
            const shortLoc = getShortLocationName(item.locationName, item.city);
            const city = getCityCode(item.city);
            const deadlineSuffix = item.deadline ? ` | ddl ${item.deadline}` : "";
            lines.push(
                `${icon} [${city}] ${shortLoc} | need ${item.needed} | gap ${item.gap}` +
                ` | hr ${item.hrPool} | mentor ${item.mentorPool} | final ${item.finalPool}` +
                ` | first-shift ${item.reservedFirstShift}${deadlineSuffix}`
            );
        }

        if (board.items.length > 14) {
            lines.push("");
            lines.push(`<i>+${board.items.length - 14} more locations</i>`);
        }

        return lines.join("\n");
    },

    formatNeedDetail(item: HiringNeedItem): string {
        const override = item.overrideUrgency ? ` (override: ${urgencyLabel(item.overrideUrgency)})` : "";
        return (
            `🎯 <b>Need Control</b>\n\n` +
            `📍 <b>${item.locationName}</b> (${item.city})\n` +
            `Priority: <b>${urgencyLabel(item.urgency)}</b>${override}\n` +
            `Need: <b>${item.needed}</b>\n` +
            `Operational gap: <b>${item.gap}</b>\n` +
            `HR pool: <b>${item.hrPool}</b>\n` +
            `Mentor pool: <b>${item.mentorPool}</b>\n` +
            `Final pool: <b>${item.finalPool}</b>\n` +
            `First shift scheduled: <b>${item.reservedFirstShift}</b>\n` +
            `Hired 7d: <b>${item.hired7d}</b>\n` +
            `Deadline: <b>${item.deadline || "—"}</b>\n` +
            `Note: <b>${item.note || "—"}</b>`
        );
    },

    getUrgencyIcon(urgency: HiringUrgency): string {
        return urgencyIcon(urgency);
    },

    getUrgencyLabel(urgency: HiringUrgency): string {
        return urgencyLabel(urgency);
    },

    async setUrgencyOverride(locationId: string, urgency: HiringUrgency | null): Promise<void> {
        const state = await readMetaState();
        const current = state[locationId] || {};
        const next: HiringNeedMeta = { ...current, updatedAt: new Date().toISOString() };
        if (urgency) next.urgency = urgency;
        else delete next.urgency;
        if (!next.urgency && !next.deadline && !next.note) {
            delete state[locationId];
        } else {
            state[locationId] = next;
        }
        await writeMetaState(state);
    },

    async setDeadline(locationId: string, deadline: string | null): Promise<void> {
        const state = await readMetaState();
        const current = state[locationId] || {};
        const next: HiringNeedMeta = { ...current, updatedAt: new Date().toISOString() };
        if (deadline) next.deadline = deadline;
        else delete next.deadline;
        if (!next.urgency && !next.deadline && !next.note) {
            delete state[locationId];
        } else {
            state[locationId] = next;
        }
        await writeMetaState(state);
    },

    async setNote(locationId: string, note: string | null): Promise<void> {
        const state = await readMetaState();
        const current = state[locationId] || {};
        const next: HiringNeedMeta = { ...current, updatedAt: new Date().toISOString() };
        if (note) next.note = note;
        else delete next.note;
        if (!next.urgency && !next.deadline && !next.note) {
            delete state[locationId];
        } else {
            state[locationId] = next;
        }
        await writeMetaState(state);
    },

    async adjustNeededCount(locationId: string, delta: number): Promise<number> {
        const current = await prisma.location.findUnique({
            where: { id: locationId },
            select: { neededCount: true }
        });
        const currentCount = Math.max(0, current?.neededCount || 0);
        const nextCount = Math.max(0, currentCount + delta);
        await prisma.location.update({
            where: { id: locationId },
            data: { neededCount: nextCount }
        });
        return nextCount;
    }
};
