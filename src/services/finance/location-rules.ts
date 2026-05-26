import type { Location } from "@prisma/client";
import { normalizeFinanceString } from "./utils.js";

type FinanceLocationLike = Pick<Location, "name" | "legacyName" | "city" | "sheet">;

function isFlyKidsKyivLocation(loc?: Partial<FinanceLocationLike> | null): boolean {
    if (!loc) return false;

    const city = normalizeFinanceString(loc.city || "");
    const names = [loc.name, loc.legacyName, loc.sheet].filter(Boolean).map(value => normalizeFinanceString(String(value)));

    return city === normalizeFinanceString("Київ")
        && names.some(name => name.includes(normalizeFinanceString("Fly Kids")) || name.includes(normalizeFinanceString("FK Київ")));
}

export function shouldExcludeTerminalFromFopAccounting(loc?: Partial<FinanceLocationLike> | null): boolean {
    return isFlyKidsKyivLocation(loc);
}

export function getReportableTerminalAmount(
    terminalAmount: number,
    loc?: Partial<FinanceLocationLike> | null
): number {
    return shouldExcludeTerminalFromFopAccounting(loc) ? 0 : terminalAmount;
}
