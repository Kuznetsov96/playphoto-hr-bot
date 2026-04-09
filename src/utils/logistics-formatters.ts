import { formatLocationName } from "../handlers/admin/utils.js";

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
} | null | undefined;

export function formatLogisticsPhotographerName(staff: StaffWithUser): string {
    const fullName = staff?.fullName?.trim();
    const username = staff?.user?.username?.trim();
    // Insert a zero-width space after "@" so Telegram doesn't turn it into an active mention.
    const usernameSuffix = username ? ` (@\u200B${username})` : "";

    if (fullName) return `${fullName}${usernameSuffix}`;

    const firstName = staff?.user?.firstName?.trim();
    const lastName = staff?.user?.lastName?.trim();
    if (firstName && lastName) return `${lastName} ${firstName}${usernameSuffix}`;
    if (firstName) return `${firstName}${usernameSuffix}`;

    return "Unknown";
}

export function formatLogisticsLocation(location: LocationLike): string {
    if (!location?.name) return "Unknown";
    if (!location.city) return location.name;
    return formatLocationName(location.name, location.city);
}
