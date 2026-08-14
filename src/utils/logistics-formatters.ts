import { escapeHtml, formatLocationName } from "../handlers/admin/utils.js";

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

export function formatLogisticsLocation(location: LocationLike): string {
    if (!location?.name) return "Unknown";
    if (!location.city) return location.name;
    return formatLocationName(location.name, location.city, location.branch);
}

/**
 * Labels a location on a shift row: the venue name, plus `branch` when the canonical catalogue
 * records one. Never the city.
 *
 * The rule is "show what the catalogue says distinguishes this venue", not "show enough to be
 * unique in the database". Those differ, and the difference is the point:
 *
 *   Smile Park (Троєщина)   — two Smile Parks in Kyiv, so the catalogue carries a branch
 *   Volkland (Шевчик)       — three in Zaporizhzhia, likewise
 *   Kidlandia               — the only one; parentheses would discriminate nothing
 *   Karamel                 — three of them, but one per city (Kolomyia/Sambir/Sheptytskyi)
 *
 * The last case is why the city is absent. Karamel collides only across cities, and a
 * photographer's schedule is effectively single-city, so those rows never appear side by side.
 * Verified against production: of 98 photographers with shifts in the last 90 days, exactly one
 * works in two cities (Cherkasy + Zaporizhzhia, different venue names), and *no* photographer
 * sees two identical labels. Same-named venues within one city always carry a branch.
 *
 * This keeps the label a pure function of one location — it never shifts because some unrelated
 * venue opened elsewhere, which is what a database-wide uniqueness rule would do. When a genuine
 * collision does appear, the catalogue is what should gain a branch; `assertUniqueShiftLocationLabels`
 * reports it rather than letting the bot invent a discriminator of its own.
 *
 * Still routed through `formatLocationName` so DDS prefixes and a city echoed inside the raw name
 * ("Smile Park Харків") are stripped exactly as everywhere else.
 */
export function formatShiftLocationLabel(location: LocationLike): string {
    if (!location?.name) return "Unknown";
    if (!location.city) return location.name;

    const branch = location.branch?.trim();

    // Called without the branch on purpose: this is only for its cleanup (DDS prefixes, a city
    // echoed inside the raw name). Passing the branch would have it appended here too, and the
    // trailing-group strip below would then leave "Smile Park (Троєщина) (Троєщина)".
    const cleaned = formatLocationName(location.name, location.city);

    // `formatLocationName` always appends "(City)". Drop that trailing group — anchored to the
    // end, so a city echoed *inside* the name has already been handled by the cleanup above.
    const withoutCity = cleaned.replace(/\s*\([^()]*\)\s*$/u, "").trim();

    // Guard against the name collapsing to nothing (a raw name that was only a city).
    if (!withoutCity) return cleaned;

    return branch ? `${withoutCity} (${branch})` : withoutCity;
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
    locations: Array<{ name?: string | null; city?: string | null; branch?: string | null; canonicalCode?: string | null }>
): LabelCollision[] {
    const byLabel = new Map<string, string[]>();

    for (const location of locations) {
        const label = formatShiftLocationLabel(location);
        const codes = byLabel.get(label) ?? [];
        codes.push(location.canonicalCode ?? location.name ?? "<unknown>");
        byLabel.set(label, codes);
    }

    return [...byLabel.entries()]
        .filter(([, codes]) => codes.length > 1)
        .map(([label, canonicalCodes]) => ({ label, canonicalCodes: canonicalCodes.sort() }));
}
