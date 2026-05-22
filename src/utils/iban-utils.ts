/**
 * Identifies Ukrainian bank name by IBAN.
 *
 * Ukrainian IBAN format: UA + 2 check digits + 6 digits bank code (MFO) + account number.
 */
export const UKRAINIAN_IBAN_LENGTH = 29;

export const UKRAINIAN_BANKS_BY_MFO: Record<string, string> = {
    "322001": "Monobank / Universal Bank (АТ \"Універсал Банк\")",
    "305299": "PrivatBank (ПриватБанк)",
    "300465": "Oschadbank (Ощадбанк)",
    "322313": "Ukreximbank (Укрексімбанк)",
    "339500": "Tascombank (ТАСКОМБАНК)",
    "380805": "Raiffeisen Bank (Райффайзен Банк)",
    "300528": "OTP Bank (ОТП Банк)",
    "334851": "PUMB (ПУМБ)",
    "351005": "Ukrsibbank (Укрсиббанк)",
    "320478": "Ukrgazbank (Укргазбанк)",
    "300346": "Sens Bank (Сенс Банк)",
    "325365": "KredoBank (Кредобанк)",
    "307770": "A-Bank (А-Банк)",
    "300614": "Credit Agricole (Креді Агріколь)",
    "328168": "Pivdennyi Bank (Банк Південний)",
};

export function normalizeIban(iban?: string | null): string {
    return (iban || "").toUpperCase().replace(/[\s-]/g, "");
}

export function getUkrainianIbanMfo(iban?: string | null): string | null {
    const cleanIban = normalizeIban(iban);
    if (!cleanIban.startsWith("UA") || cleanIban.length < 10) return null;
    return cleanIban.substring(4, 10);
}

export function isValidIbanChecksum(iban?: string | null): boolean {
    const cleanIban = normalizeIban(iban);
    if (!/^[A-Z0-9]+$/.test(cleanIban) || cleanIban.length < 4) return false;

    const rearranged = cleanIban.slice(4) + cleanIban.slice(0, 4);
    let remainder = 0;

    for (const char of rearranged) {
        const digits = /[A-Z]/.test(char)
            ? String(char.charCodeAt(0) - 55)
            : char;

        for (const digit of digits) {
            remainder = (remainder * 10 + Number(digit)) % 97;
        }
    }

    return remainder === 1;
}

export function isValidUkrainianIban(iban?: string | null): boolean {
    const cleanIban = normalizeIban(iban);
    return cleanIban.startsWith("UA")
        && cleanIban.length === UKRAINIAN_IBAN_LENGTH
        && isValidIbanChecksum(cleanIban);
}

export function getBankNameByIban(iban?: string | null): string {
    if (!iban) return "—";

    const cleanIban = normalizeIban(iban);
    if (!cleanIban.startsWith("UA")) return "Unknown Format";
    if (cleanIban.length !== UKRAINIAN_IBAN_LENGTH) return "Invalid Ukrainian IBAN";

    const mfo = getUkrainianIbanMfo(cleanIban);
    if (!mfo || !/^\d{6}$/.test(mfo)) return "Unknown Format";
    if (!isValidIbanChecksum(cleanIban)) return `Invalid Ukrainian IBAN (MFO: ${mfo})`;

    return UKRAINIAN_BANKS_BY_MFO[mfo] || `Other Bank (MFO: ${mfo})`;
}

const nbuBankNameCache = new Map<string, string>();

function formatOfficialBankName(row: any): string | null {
    const shortName = typeof row?.N_GOL === "string" ? row.N_GOL.trim() : "";
    const fullName = typeof row?.FULLNAME === "string" ? row.FULLNAME.trim() : "";
    const branchName = typeof row?.SHORTNAME === "string" ? row.SHORTNAME.trim() : "";

    return shortName || fullName || branchName || null;
}

async function getOfficialBankNameByMfo(mfo: string): Promise<string | null> {
    const cached = nbuBankNameCache.get(mfo);
    if (cached) return cached;

    const response = await fetch(`https://bank.gov.ua/NBU_BankInfo/get_data_branch?glmfo=${mfo}&json`);
    if (!response.ok) return null;

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const bankRow = rows.find((row: any) => String(row?.MFO || row?.GLMFO) === mfo) || rows[0];
    const bankName = formatOfficialBankName(bankRow);
    if (!bankName) return null;

    nbuBankNameCache.set(mfo, bankName);
    return bankName;
}

export async function resolveBankNameByIban(iban?: string | null): Promise<string> {
    const baseResult = getBankNameByIban(iban);
    const mfo = getUkrainianIbanMfo(iban);

    if (!mfo || baseResult === "—" || baseResult === "Unknown Format" || baseResult.startsWith("Invalid")) {
        return baseResult;
    }

    try {
        const officialBankName = await getOfficialBankNameByMfo(mfo);
        return officialBankName || baseResult;
    } catch {
        return baseResult;
    }
}
