/**
 * Вёрстка вечерней сводки для Telegram.
 *
 * Отдельный модуль без сети и без базы: текст, который владелец читает каждый
 * вечер, проверяется на чистых данных, а не через мок HTTP-клиента.
 */

export type DailySummaryView = {
    totals: { salesTotal: number; cashTotal: number; terminalTotal: number };
    locations: Array<{
        publicId: string;
        label: string;
        salesTotal: number;
        cashTotal: number;
        terminalTotal: number;
    }>;
    overdue: Array<{ publicId: string; label: string; openedAt?: string | null }>;
    neverOpened: Array<{ publicId: string; label: string }>;
};

/** Сколько локаций печатать поимённо, прежде чем свернуть остаток в одну строку. */
const TOP_LOCATIONS = 8;

const BUSINESS_TIMEZONE = "Europe/Kyiv";

/**
 * Собирает сообщение.
 *
 * `summary === null` — сводку получить не удалось. Сообщение всё равно уходит:
 * молчание в 21:40 читается как «день пустой», а не как «отчёт сломался», и
 * именно в этом виде дефект живёт незамеченным неделями.
 */
export function renderDailySummary(summary: DailySummaryView | null, localDate: string): string {
    const heading = `📊 <b>Daily Summary</b> · ${escapeHtml(formatDate(localDate))}`;

    if (summary === null) {
        return `${heading}\n\n⚠️ Today's figures could not be loaded from the app.`;
    }

    const lines: string[] = [heading, ""];

    if (summary.locations.length === 0) {
        lines.push("No sales recorded today.");
    } else {
        lines.push(`<b>${escapeHtml(formatMoney(summary.totals.salesTotal))} ₴</b>`, "");

        for (const location of summary.locations.slice(0, TOP_LOCATIONS)) {
            lines.push(`${escapeHtml(location.label)} — <b>${escapeHtml(formatMoney(location.salesTotal))}</b>`);
        }
        const hidden = summary.locations.length - TOP_LOCATIONS;
        if (hidden > 0) lines.push(`<i>…${hidden} more</i>`);

        lines.push(
            "",
            `💵 Cash ${escapeHtml(formatMoney(summary.totals.cashTotal))}`,
            `💳 Terminal ${escapeHtml(formatMoney(summary.totals.terminalTotal))}`
        );
    }

    if (summary.overdue.length > 0) {
        lines.push("", `⚠️ <b>Still open (${summary.overdue.length})</b>`);
        for (const row of summary.overdue) {
            const since = row.openedAt ? ` — since ${escapeHtml(formatTime(row.openedAt))}` : "";
            lines.push(`• ${escapeHtml(row.label)}${since}`);
        }
    }

    if (summary.neverOpened.length > 0) {
        lines.push("", `🚫 <b>Never opened (${summary.neverOpened.length})</b>`);
        for (const row of summary.neverOpened) {
            lines.push(`• ${escapeHtml(row.label)}`);
        }
    }

    return lines.join("\n");
}

/**
 * Тысячи через неразрывный пробел.
 *
 * Собирается вручную, а не через `toLocaleString`: Intl печатает гривну и
 * разделители по-разному в разных средах, и сумма в сообщении не должна
 * зависеть от того, где собрали контейнер.
 */
function formatMoney(value: number): string {
    const rounded = Math.round(value);
    const sign = rounded < 0 ? "-" : "";
    const digits = Math.abs(rounded).toString();
    const groups: string[] = [];
    for (let end = digits.length; end > 0; end -= 3) {
        groups.unshift(digits.slice(Math.max(0, end - 3), end));
    }
    return sign + groups.join(" ");
}

/** `YYYY-MM-DD` → `6 Sep 2026`. */
function formatDate(localDate: string): string {
    const [year, month, day] = localDate.split("-").map(Number);
    if (!year || !month || !day) return localDate;
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** ISO-момент → `HH:MM` по Киеву: владелец читает местное время, не UTC. */
function formatTime(iso: string): string {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: BUSINESS_TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(parsed);
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
