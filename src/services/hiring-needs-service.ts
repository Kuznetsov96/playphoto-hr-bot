import { CandidateStatus, FunnelStep } from "@prisma/client";
import prisma from "../db/core.js";
import { systemStateRepository } from "../repositories/system-state-repository.js";
import { getCityCode, getShortLocationName } from "../utils/location-helpers.js";
import { escapeHtml, formatLocation } from "../handlers/admin/utils.js";

export type HiringUrgency = "NORMAL" | "CRITICAL";

type HiringNeedMeta = {
    urgency?: "CRITICAL";
    deadline?: string;
    note?: string;
    updatedAt?: string;
};

type HiringNeedMetaState = Record<string, HiringNeedMeta>;

export type HiringNeedItem = {
    locationId: string;
    locationName: string;
    /** Canonical discriminator for venues sharing a name; null when the venue is the only one. */
    branch: string | null;
    city: string;
    isHiddenFromCandidates: boolean;
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
        urgent: number;
        normal: number;
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
            return 2;
        case "NORMAL":
        default:
            return 1;
    }
}

function urgencyIcon(urgency: HiringUrgency): string {
    switch (urgency) {
        case "CRITICAL":
            return "🔴";
        case "NORMAL":
        default:
            return "🟠";
    }
}

function urgencyLabel(urgency: HiringUrgency): string {
    switch (urgency) {
        case "CRITICAL":
            return "Urgent";
        case "NORMAL":
        default:
            return "Standard";
    }
}

function normalizeUrgency(value?: string): HiringUrgency | null {
    if (!value) return null;
    if (value === "CRITICAL" || value === "HIGH") return "CRITICAL";
    return null;
}

function createEmptyItem(
    location: { id: string; name: string; branch?: string | null; city: string; neededCount: number | null; isHiddenFromCandidates: boolean },
    meta: HiringNeedMeta
): HiringNeedItem {
    const needed = Math.max(0, location.neededCount || 0);
    const overrideUrgency = normalizeUrgency(meta.urgency);

    return {
        locationId: location.id,
        locationName: location.name,
        branch: location.branch ?? null,
        city: location.city,
        isHiddenFromCandidates: location.isHiddenFromCandidates,
        needed,
        hrPool: 0,
        mentorPool: 0,
        finalPool: 0,
        reservedFirstShift: 0,
        hired7d: 0,
        gap: needed,
        urgency: overrideUrgency || "NORMAL",
        overrideUrgency,
        deadline: meta.deadline || null,
        note: meta.note || null
    };
}

function applyCandidateToItem(
    row: HiringNeedItem,
    candidate: {
        status: CandidateStatus;
        statusChangedAt: Date | null;
        firstShiftDate: Date | null;
        currentStep: FunnelStep | null;
        user: { botBlockedAt: Date | null };
    },
    weekAgo: Date
) {
    if (candidate.user.botBlockedAt) return;

    if (candidate.status === CandidateStatus.HIRED) {
        if (candidate.statusChangedAt && candidate.statusChangedAt >= weekAgo) {
            row.hired7d++;
        }
        return;
    }

    if (HR_POOL_STATUSES.has(candidate.status)) row.hrPool++;
    if (MENTOR_POOL_STATUSES.has(candidate.status)) row.mentorPool++;
    if (FINAL_POOL_STATUSES.has(candidate.status)) row.finalPool++;

    if (
        RESERVED_FIRST_SHIFT_STATUSES.has(candidate.status) &&
        candidate.firstShiftDate &&
        candidate.currentStep === FunnelStep.FIRST_SHIFT
    ) {
        row.reservedFirstShift++;
    }
}

function finalizeItem(row: HiringNeedItem): HiringNeedItem {
    row.gap = Math.max(0, row.needed - row.reservedFirstShift);
    row.urgency = row.overrideUrgency ? "CRITICAL" : "NORMAL";
    return row;
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
    async getBoard(options: { includeEmpty?: boolean } = {}): Promise<HiringNeedsBoard> {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [locations, candidates, metaState] = await Promise.all([
            prisma.location.findMany({
                where: { isHidden: false },
                select: { id: true, name: true, branch: true, city: true, neededCount: true, isHiddenFromCandidates: true }
            }),
            prisma.candidate.findMany({
                where: { locationId: { not: null } },
                select: {
                    locationId: true,
                    status: true,
                    statusChangedAt: true,
                    firstShiftDate: true,
                    currentStep: true,
                    user: { select: { botBlockedAt: true } }
                }
            }),
            readMetaState()
        ]);

        const byLocation = new Map<string, HiringNeedItem>();
        for (const location of locations) {
            const meta = metaState[location.id] || {};
            byLocation.set(location.id, createEmptyItem(location, meta));
        }

        for (const candidate of candidates) {
            const locationId = candidate.locationId || "";
            const row = byLocation.get(locationId);
            if (!row) continue;
            applyCandidateToItem(row, candidate, weekAgo);
        }

        const items = Array.from(byLocation.values()).map(finalizeItem).filter((row) => options.includeEmpty ||
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
            urgent: items.filter((item) => item.urgency === "CRITICAL").length,
            normal: items.filter((item) => item.urgency === "NORMAL").length,
            totalNeed: items.reduce((acc, item) => acc + item.needed, 0),
            totalGap: items.reduce((acc, item) => acc + item.gap, 0),
        };

        return { totals, items };
    },

    async getLocationItem(locationId: string): Promise<HiringNeedItem | null> {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const [location, candidates, metaState] = await Promise.all([
            prisma.location.findFirst({
                where: { id: locationId, isHidden: false },
                select: { id: true, name: true, branch: true, city: true, neededCount: true, isHiddenFromCandidates: true }
            }),
            prisma.candidate.findMany({
                where: { locationId },
                select: {
                    status: true,
                    statusChangedAt: true,
                    firstShiftDate: true,
                    currentStep: true,
                    user: { select: { botBlockedAt: true } }
                }
            }),
            readMetaState()
        ]);

        if (!location) return null;
        const item = createEmptyItem(location, metaState[locationId] || {});
        for (const candidate of candidates) {
            applyCandidateToItem(item, candidate, weekAgo);
        }
        return finalizeItem(item);
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
        lines.push(`Need: <b>${board.totals.totalNeed}</b> | Open: <b>${board.totals.totalGap}</b>`);
        lines.push(`Urgent: <b>${board.totals.urgent}</b>`);
        lines.push("");

        const visibleItems = board.items.filter((item) => item.needed > 0);

        if (visibleItems.length === 0) {
            lines.push("No active hiring demand right now.");
            return lines.join("\n");
        }

        if (role === "ADMIN") {
            lines.push("<i>Select location below.</i>");
            return lines.join("\n");
        }

        for (const item of visibleItems.slice(0, 8)) {
            const icon = urgencyIcon(item.urgency);
            const shortLoc = getShortLocationName(item.locationName, item.city, item.branch);
            const city = getCityCode(item.city);
            const deadlineSuffix = item.deadline ? ` | ddl ${item.deadline}` : "";
            lines.push(
                `${icon} [${city}] ${shortLoc} | need ${item.needed} | open ${item.gap}` +
                ` | hr ${item.hrPool} | mentor ${item.mentorPool} | final ${item.finalPool}` +
                ` | first-shift ${item.reservedFirstShift}${deadlineSuffix}`
            );
        }

        if (visibleItems.length > 8) {
            lines.push("");
            lines.push(`<i>+${visibleItems.length - 8} more locations</i>`);
        }

        return lines.join("\n");
    },

    formatRoleSummary(board: HiringNeedsBoard, role: "HR" | "MENTOR", page = 1, pageSize = 7): string {
        const visibleItems = board.items.filter((item) => item.needed > 0);
        const totalPages = Math.max(1, Math.ceil(visibleItems.length / pageSize));
        const safePage = Math.min(Math.max(1, page), totalPages);
        const pageItems = visibleItems.slice((safePage - 1) * pageSize, safePage * pageSize);
        const title = role === "HR" ? "Hiring Needs" : "Location Priorities";
        const lines: string[] = [
            `🎯 <b>${title}</b>`,
            `Need: <b>${board.totals.totalNeed}</b> | Open: <b>${board.totals.totalGap}</b> | Urgent: <b>${board.totals.urgent}</b>`,
            ""
        ];

        if (visibleItems.length === 0) {
            lines.push("No open hiring needs right now.");
            return lines.join("\n");
        }

        if (totalPages > 1) {
            lines.push(`Page <b>${safePage}</b>/<b>${totalPages}</b>`);
            lines.push("");
        }

        for (const item of pageItems) {
            const icon = urgencyIcon(item.urgency);
            const city = getCityCode(item.city);
            const loc = getShortLocationName(item.locationName, item.city, item.branch);
            const deadline = item.deadline ? ` | ${item.deadline}` : "";
            const note = item.note ? ` | ${item.note}` : "";

            if (role === "HR") {
                lines.push(`${icon} [${city}] ${loc}: need ${item.needed}, open ${item.gap}, HR ${item.hrPool}${deadline}${note}`);
            } else {
                lines.push(`${icon} [${city}] ${loc}: open ${item.gap}, mentor ${item.mentorPool}, final ${item.finalPool}${deadline}${note}`);
            }
        }

        return lines.join("\n");
    },

    formatNeedDetail(item: HiringNeedItem): string {
        const urgent = item.overrideUrgency ? "Yes" : "No";
        const poolParts = [
            item.hrPool > 0 ? `HR <b>${item.hrPool}</b>` : null,
            item.mentorPool > 0 ? `Mentor <b>${item.mentorPool}</b>` : null,
            item.finalPool > 0 ? `Final <b>${item.finalPool}</b>` : null,
        ].filter(Boolean);

        const lines = [
            `🎯 <b>Need Control</b>`,
            "",
            `📍 <b>${escapeHtml(formatLocation({ name: item.locationName, branch: item.branch, city: item.city }, "listing"))}</b>`,
            `Need: <b>${item.needed}</b> | Open: <b>${item.gap}</b>`,
        ];
        if (item.overrideUrgency) {
            lines.push(`Urgent: <b>${urgent}</b>`);
        }

        if (poolParts.length > 0) {
            lines.push(`Pool: ${poolParts.join(" | ")}`);
        }

        if (item.reservedFirstShift > 0) {
            lines.push(`First shift: <b>${item.reservedFirstShift}</b>`);
        }

        if (item.hired7d > 0) {
            lines.push(`Hired 7d: <b>${item.hired7d}</b>`);
        }

        if (item.isHiddenFromCandidates) {
            lines.push(`Candidate status: <b>Hidden</b>`);
        }

        if (item.deadline) {
            lines.push(`Deadline: <b>${item.deadline}</b>`);
        }

        if (item.note) {
            lines.push(`Note: <b>${item.note}</b>`);
        }

        return lines.join("\n");
    },

    getUrgencyIcon(urgency: HiringUrgency): string {
        return urgencyIcon(urgency);
    },

    getUrgencyLabel(urgency: HiringUrgency): string {
        return urgencyLabel(urgency);
    },

    getUrgencyRank(urgency: HiringUrgency): number {
        return urgencyWeight(urgency);
    },

    async setUrgencyOverride(locationId: string, urgency: "CRITICAL" | null): Promise<void> {
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
