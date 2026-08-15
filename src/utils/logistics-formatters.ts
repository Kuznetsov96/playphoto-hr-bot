import { formatLocation, type LocationDisplayContext } from "./location-label.js";
import { escapeHtml } from "../handlers/admin/utils.js";

type StaffWithUser = {
    fullName?: string | null;
    user?: {
        firstName?: string | null;
        lastName?: string | null;
        username?: string | null;
    } | null;
} | null | undefined;

type LocationLike = {
    name?: string | null;
    city?: string | null;
    branch?: string | null;
} | null | undefined;

export function formatLogisticsPhotographerName(staff: StaffWithUser): string {
    const fullName = staff?.fullName?.trim();
    const username = staff?.user?.username?.trim();
    const usernameSuffix = username ? ` (<a href="https://t.me/${escapeHtml(username)}">@${escapeHtml(username)}</a>)` : "";

    if (fullName) return `${escapeHtml(shortenPhotographerName(fullName))}${usernameSuffix}`;

    const firstName = staff?.user?.firstName?.trim();
    const lastName = staff?.user?.lastName?.trim();
    if (firstName && lastName) return `${escapeHtml(`${lastName} ${firstName}`)}${usernameSuffix}`;
    if (firstName) return `${escapeHtml(firstName)}${usernameSuffix}`;

    return "Unknown";
}

function shortenPhotographerName(fullName: string): string {
    const parts = fullName.split(/\s+/).filter(Boolean);
    return parts.length > 2 ? parts.slice(0, 2).join(" ") : fullName;
}

/** Parcels move between cities, so a logistics row has to name the one it is talking about. */
export function formatLogisticsLocation(location: LocationLike): string {
    return formatLocation(location, "listing");
}

/**
 * Labels a location on a photographer's shift row. The city is omitted because the schedule is
 * effectively single-city: verified against production, of 98 photographers with shifts in the
 * last 90 days exactly one works in two cities (Cherkasy + Zaporizhzhia, different venue names),
 * and no photographer sees two identical labels.
 *
 * That assumption rests on the catalogue carrying a `branch` for every venue sharing a name with
 * another in the same city. `findShiftLocationLabelCollisions` is what keeps it honest rather than
 * silently load-bearing.
 */
export function formatShiftLocationLabel(location: LocationLike): string {
    return formatLocation(location, "in-city");
}

export type LabelCollision = {
    label: string;
    canonicalCodes: string[];
};

/**
 * Finds locations that would render as the same shift label.
 *
 * The label deliberately omits the city, which holds only because the canonical catalogue
 * records a `branch` for every venue that shares a name with another in the same city. That is
 * an assumption about data maintained elsewhere, so it is checked rather than trusted: if a new
 * venue ever lands without the branch that distinguishes it, a photographer would see two
 * identical rows — the exact confusion this whole change set exists to remove.
 *
 * Reporting beats guessing. The bot must not invent a discriminator (that is how "Volkland 1"
 * came about); the catalogue is where the missing branch belongs, and this gives the operator
 * the canonical codes to go and fix.
 *
 * Cross-city duplicates are reported too even though no single photographer can currently see
 * both — a schedule is effectively single-city only as long as that stays true, and a silent
 * dependency on it is worse than a warning that turns out to be noise.
 */
export function findShiftLocationLabelCollisions(
    locations: Array<{ name?: string | null; city?: string | null; branch?: string | null; canonicalCode?: string | null }>,
    context: LocationDisplayContext = "in-city"
): LabelCollision[] {
    const byLabel = new Map<string, string[]>();

    for (const location of locations) {
        const label = formatLocation(location, context);
        const codes = byLabel.get(label) ?? [];
        codes.push(location.canonicalCode ?? location.name ?? "<unknown>");
        byLabel.set(label, codes);
    }

    return [...byLabel.entries()]
        .filter(([, codes]) => codes.length > 1)
        .map(([label, canonicalCodes]) => ({ label, canonicalCodes: canonicalCodes.sort() }));
}
