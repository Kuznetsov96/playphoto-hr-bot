import { leadService } from "./lead-service.js";
import { LeadPlatform } from "@prisma/client";
import { redis } from "../core/redis.js";
import { type Api } from "grammy";
import logger from "../core/logger.js";
import fetch from "node-fetch";
import { logBusinessEvent } from "../core/log-events.js";

const WORK_UA_API_BASE = "https://api.work.ua";
const LAST_ID_KEY = "work_ua:last_response_id";
const VACANCIES_CACHE_KEY = "work_ua:vacancies_cache";

export class WorkUAService {
    private vacanciesMap: Map<number, { name: string, region_id: number }> = new Map();
    private lastVacanciesFetch = 0;

    /**
     * Починає цикл опитування Work.ua API (Polling)
     */
    startPolling(api: Api) {
        logger.info("🕒 Work.ua polling service started (every 15m)");
        logBusinessEvent({
            event: "integration.workua.polling_loop.started",
            actorType: "system",
            actorRole: "system",
            result: "success",
            module: "work-ua-service",
            operation: "startPolling",
            safeContext: {
                intervalMinutes: 15,
            },
        });
        
        // Перевіряємо кожні 15 хвилин
        setInterval(async () => {
            try {
                await this.checkNewResponses(api);
            } catch (e) {
                logger.error({ err: e }, "❌ Error in Work.ua polling loop");
                logBusinessEvent({
                    event: "integration.workua.polling_iteration.failed",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    module: "work-ua-service",
                    operation: "startPolling",
                    error: e,
                });
            }
        }, 15 * 60 * 1000);

        // Перший запуск через 1 хвилину після старту бота
        setTimeout(() => this.checkNewResponses(api), 60 * 1000);
    }

    /**
     * Отримує список активних вакансій для мапінгу job_id -> City
     */
    private async refreshVacancies() {
        // Оновлюємо кеш раз на годину
        if (Date.now() - this.lastVacanciesFetch < 3600000 && this.vacanciesMap.size > 0) return;

        try {
            const auth = this.getAuthHeader();
            const res = await fetch(`${WORK_UA_API_BASE}/jobs/my?active=1&full=1`, {
                headers: { "Authorization": `Basic ${auth}`, "User-Agent": "PlayPhoto (playphoto.hub@gmail.com)" }
            });

            if (!res.ok) {
                const text = await res.text();
                logger.error({ status: res.status, body: text.slice(0, 100) }, "❌ Work.ua API vacancies error");
                logBusinessEvent({
                    event: "integration.workua.vacancies_refreshed",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    reasonCode: "WORKUA_VACANCIES_API_ERROR",
                    module: "work-ua-service",
                    operation: "refreshVacancies",
                    safeContext: {
                        status: res.status,
                    },
                });
                return;
            }

            const data = await res.json() as any;
            
            if (data.status === 'ok' && data.items) {
                this.vacanciesMap.clear();
                for (const job of data.items) {
                    this.vacanciesMap.set(Number(job.id), { 
                        name: job.name, 
                        region_id: job.region 
                    });
                }
                this.lastVacanciesFetch = Date.now();
                logger.info({ count: this.vacanciesMap.size }, "✅ Work.ua vacancies map updated");
                logBusinessEvent({
                    event: "integration.workua.vacancies_refreshed",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "work-ua-service",
                    operation: "refreshVacancies",
                    safeContext: {
                        vacanciesCount: this.vacanciesMap.size,
                    },
                });
            }
        } catch (e) {
            logger.error({ err: e }, "Failed to fetch Work.ua vacancies");
            logBusinessEvent({
                event: "integration.workua.vacancies_refreshed",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "WORKUA_VACANCIES_FETCH_FAILED",
                module: "work-ua-service",
                operation: "refreshVacancies",
                error: e,
            });
        }
    }

    private getAuthHeader() {
        const email = process.env.WORK_UA_EMAIL;
        const password = process.env.WORK_UA_PASSWORD;
        if (!email || !password) throw new Error("WORK_UA credentials missing");
        return Buffer.from(`${email}:${password}`).toString('base64');
    }

    /**
     * Перевіряє наявність нових відгуків через API
     */
    async checkNewResponses(api: Api) {
        await this.refreshVacancies();
        
        const lastId = await redis.get(LAST_ID_KEY);
        const auth = this.getAuthHeader();

        // Якщо це перший запуск (немає lastId), ініціалізуємо його найновішим ID
        if (!lastId) {
            logger.info("🆕 Work.ua initialization: fetching latest response ID...");
            const initUrl = `${WORK_UA_API_BASE}/jobs/responses?limit=1&sort=0`; 
            try {
                const initRes = await fetch(initUrl, {
                    headers: { "Authorization": `Basic ${auth}`, "User-Agent": "PlayPhoto (playphoto.hub@gmail.com)" }
                });

                if (!initRes.ok) {
                    const text = await initRes.text();
                    logger.error({ status: initRes.status, body: text.slice(0, 100) }, "❌ Work.ua API init error");
                    logBusinessEvent({
                        event: "integration.workua.initialized",
                        level: "error",
                        actorType: "system",
                        actorRole: "system",
                        result: "failed",
                        reasonCode: "WORKUA_INIT_API_ERROR",
                        module: "work-ua-service",
                        operation: "checkNewResponses",
                        safeContext: {
                            status: initRes.status,
                        },
                    });
                    return;
                }

                const initData = await initRes.json() as any;
                if (initData.status === 'ok' && initData.items?.[0]) {
                    const latestId = initData.items[0].id;
                    await redis.set(LAST_ID_KEY, String(latestId));
                    logger.info({ latestId }, "✅ Work.ua service initialized with the latest ID");
                    logBusinessEvent({
                        event: "integration.workua.initialized",
                        actorType: "system",
                        actorRole: "system",
                        result: "success",
                        module: "work-ua-service",
                        operation: "checkNewResponses",
                        safeContext: {
                            latestId,
                        },
                    });
                }
            } catch (e) {
                logger.error({ err: e }, "Failed to initialize Work.ua service");
                logBusinessEvent({
                    event: "integration.workua.initialized",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    reasonCode: "WORKUA_INIT_FAILED",
                    module: "work-ua-service",
                    operation: "checkNewResponses",
                    error: e,
                });
            }
            return;
        }

        logger.info({ lastId }, "🔍 Checking Work.ua for new responses...");
        const url = `${WORK_UA_API_BASE}/jobs/responses?limit=50&sort=1&last_id=${lastId}`;

        try {
            const response = await fetch(url, {
                headers: {
                    "Authorization": `Basic ${auth}`,
                    "User-Agent": "PlayPhoto (playphoto.hub@gmail.com)",
                    "X-Locale": "uk_UA"
                }
            });

            if (!response.ok) {
                const text = await response.text();
                logger.error({ status: response.status, body: text.slice(0, 100) }, "❌ Work.ua API error response");
                logBusinessEvent({
                    event: "integration.workua.responses_checked",
                    level: "error",
                    actorType: "system",
                    actorRole: "system",
                    result: "failed",
                    reasonCode: "WORKUA_RESPONSES_API_ERROR",
                    module: "work-ua-service",
                    operation: "checkNewResponses",
                    safeContext: {
                        status: response.status,
                    },
                });
                return;
            }

            const data = await response.json() as any;
            if (data.status === 'ok' && data.items && data.items.length > 0) {
                let maxId = parseInt(lastId);
                let processedCount = 0;

                for (const item of data.items) {
                    const responseId = parseInt(item.id);
                    if (responseId > maxId) maxId = responseId;

                    // Визначаємо місто та назву вакансії
                    const jobInfo = this.vacanciesMap.get(Number(item.job_id));
                    let city = item.region || "Unknown City";
                    let leadName = item.fio || "Work.ua Candidate";
                    
                    if (jobInfo) {
                        // Якщо ми знаємо вакансію, додаємо її до імені, щоб HR бачив контекст
                        leadName = `${item.fio || "Candidate"} (${jobInfo.name})`;
                        // Місто можна витягти з назви вакансії або через словник (якщо потрібно)
                    }

                    // Форматуємо дату з ISO (Київський час)
                    let displayDate = item.date;
                    try {
                        const d = new Date(item.date);
                        displayDate = d.toLocaleString('uk-UA', { 
                            timeZone: 'Europe/Kyiv',
                            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' 
                        });
                    } catch (e) {}

                    const textContent = item.cover || item.text || "No cover letter provided";
                    city = this.extractCityFromText(textContent, city);

                    await leadService.handleIncomingMessage(api, {
                        externalId: String(item.id), // Це ID відгуку (response_id), він потрібен для браузера
                        platform: LeadPlatform.WORK_UA,
                        name: leadName,
                        text: textContent,
                        metadata: { city, originalDate: displayDate }
                    });
                    processedCount++;
                }

                await redis.set(LAST_ID_KEY, String(maxId));
                logBusinessEvent({
                    event: "integration.workua.responses_checked",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "work-ua-service",
                    operation: "checkNewResponses",
                    safeContext: {
                        previousLastId: lastId,
                        newLastId: String(maxId),
                        processedCount,
                    },
                });
            } else {
                logBusinessEvent({
                    event: "integration.workua.responses_checked",
                    actorType: "system",
                    actorRole: "system",
                    result: "success",
                    module: "work-ua-service",
                    operation: "checkNewResponses",
                    safeContext: {
                        previousLastId: lastId,
                        processedCount: 0,
                    },
                });
            }
        } catch (e) {
            logger.error({ err: e }, "Error calling Work.ua API");
            logBusinessEvent({
                event: "integration.workua.responses_checked",
                level: "error",
                actorType: "system",
                actorRole: "system",
                result: "failed",
                reasonCode: "WORKUA_CALL_FAILED",
                module: "work-ua-service",
                operation: "checkNewResponses",
                error: e,
            });
        }
    }

    private extractCityFromText(text: string, defaultCity: string): string {
        if (defaultCity && defaultCity !== "Unknown City") return defaultCity;
        const cityMatch = text.match(/(?:Готовність працювати|Адреса|Місто|Місце проживання):\s*([^\n,]+)/i);
        if (cityMatch && cityMatch[1]) {
            const extracted = cityMatch[1].trim();
            if (extracted.length > 2 && extracted.length < 30) return extracted;
        }
        return defaultCity;
    }
}

export const workUAService = new WorkUAService();
