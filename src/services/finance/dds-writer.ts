import { FINANCE_DDS_TARGET } from "../../config.js";
import logger from "../../core/logger.js";
import { AwsBusinessApiError, awsBusinessClient } from "../aws-business-client.js";
import { ddsService } from "./dds.js";

export type DdsEntry = {
    date: string;
    amount: number;
    fop: string;
    category: string;
    comment: string;
    location: string;
    /** `canonicalCode` локации — адрес для вебаппа. Без него в API не проведём. */
    locationCode: string | null;
    /** `canonicalCode` кошелька ФОПа. */
    walletCode: string | null;
    /** `canonicalCode` статьи выручки. */
    articleCode: string | null;
    paymentMethod: "CASH" | "TERMINAL";
};

export type DdsWriteResult = {
    wroteSheets: boolean;
    wroteApi: boolean;
    /** Локация уже в контуре приложения — её выручка приходит из `Sale`. */
    skippedInApp: boolean;
};

/**
 * Куда уходит проводка выручки: в лист, в ДДС вебаппа или в оба.
 *
 * Одно место принятия решения, а не ветка на каждом вызове: два места разошлись
 * бы при первой правке, и половина выручки пошла бы не туда.
 *
 * Режим `both` существует ради недели параллельной работы. Расхождение между
 * путями обнаружится только на реальных данных, и до тех пор лист остаётся
 * рабочим — переключение обязано быть обратимым переменной окружения.
 */
export async function writeDdsEntry(entry: DdsEntry): Promise<DdsWriteResult> {
    const target = FINANCE_DDS_TARGET;
    const result: DdsWriteResult = { wroteSheets: false, wroteApi: false, skippedInApp: false };

    if (target === "sheets" || target === "both") {
        await ddsService.addTransaction({
            date: entry.date,
            amount: entry.amount,
            fop: entry.fop,
            category: entry.category,
            comment: entry.comment,
            location: entry.location,
        });
        result.wroteSheets = true;
    }

    if (target === "api" || target === "both") {
        // Без канонических кодов вебапп не примет проводку. Это не сбой:
        // локация может быть заведена только в боте. Пропуск логируется, чтобы
        // такую локацию было видно, а не чтобы она молча выпала из ДДС.
        if (entry.locationCode === null || entry.walletCode === null || entry.articleCode === null) {
            logger.warn(
                { location: entry.location, date: entry.date },
                "DDS API write skipped: location, wallet or article has no canonical code"
            );
            return result;
        }
        try {
            await awsBusinessClient.recordDdsRevenue({
                paidOn: toIsoDate(entry.date),
                locationCode: entry.locationCode,
                walletCode: entry.walletCode,
                articleCode: entry.articleCode,
                amount: entry.amount.toFixed(2),
                paymentMethod: entry.paymentMethod,
                purpose: entry.comment,
            });
            result.wroteApi = true;
        } catch (error) {
            // Локация успела переехать в приложение — ожидаемый ответ, а не сбой:
            // её выручка теперь приходит из касс. Заявить это ошибкой значило бы
            // будить владельца на штатном событии.
            if (error instanceof AwsBusinessApiError && error.code === "LOCATION_ALREADY_IN_APP") {
                logger.info(
                    { location: entry.location, date: entry.date },
                    "DDS API write skipped: location already records sales in the app"
                );
                result.skippedInApp = true;
                return result;
            }
            throw error;
        }
    }

    return result;
}

/**
 * Дата из формата листа (`DD.MM.YYYY`) в ISO.
 *
 * Лист хранит дату так, как её набрал человек, а API принимает только ISO.
 * Строка, которая уже в ISO, возвращается как есть.
 */
export function toIsoDate(value: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
    const parts = value.split(".");
    if (parts.length !== 3) return value;
    const [day, month, year] = parts;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

/**
 * Кириллица → латиница по тому же правилу, что `treasuryArticleCode` в вебаппе.
 *
 * Дублируется намеренно: репозитории разные, общей библиотеки между ними нет, а
 * тянуть её ради одной функции — лишняя связность. Расхождение поймает тест,
 * который сверяет коды с фактическими статьями прода.
 */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
    а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", ё: "e", є: "ie",
    ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh",
    ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e",
    ю: "iu", я: "ia",
};

/**
 * `canonicalCode` статьи ДДС из её названия.
 *
 * Название статьи — то, что уже лежит в обеих системах, и код выводится из него
 * детерминированно. Хранить отдельное соответствие значило бы завести третий
 * справочник, который разойдётся с двумя существующими.
 */
export function ddsArticleCode(name: string): string {
    let latin = "";
    for (const character of name.toLowerCase()) {
        latin += CYRILLIC_TO_LATIN[character] ?? character;
    }
    return latin
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "");
}
