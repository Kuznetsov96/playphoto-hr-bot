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
