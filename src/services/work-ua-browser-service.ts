import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import logger from "../core/logger.js";
import { redis } from "../core/redis.js";

const WORK_UA_LOGIN_URL = "https://www.work.ua/employer/login/";
const COOKIES_KEY = "work_ua_cookies";

export class WorkUABrowserService {
    private browser: Browser | null = null;

    async sendMessage(responseId: string, text: string): Promise<boolean> {
        let context: BrowserContext | null = null;
        try {
            const proxyServer = process.env.WORK_UA_PROXY_SERVER; // формат http://ip:port
            const proxyUser = process.env.WORK_UA_PROXY_USER;
            const proxyPass = process.env.WORK_UA_PROXY_PASS;

            const launchOptions: any = { 
                headless: true, 
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"] 
            }; 

            if (proxyServer) {
                launchOptions.proxy = {
                    server: proxyServer,
                    username: proxyUser,
                    password: proxyPass
                };
                logger.info({ proxy: proxyServer }, "🌐 Using proxy for Work.ua");
            }

            this.browser = await chromium.launch(launchOptions);
            
            context = await this.getAuthenticatedContext();
            const page = await context.newPage();
            const targetUrl = `https://www.work.ua/employer/my/applicants/${responseId}/`;

            logger.info({ responseId }, "🌐 Navigating to applicant page...");
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(3000);

            // ПЕРЕВІРКА: чи нас не викинуло на логін?
            if (page.url().includes('/login/') || await page.locator('button:has-text("Увійти")').count() > 0) {
                logger.warn("🔑 Session expired, logging in again...");
                await this.login(page);
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForTimeout(3000);
            }

            // 2. ВІДКРИТТЯ ФОРМИ (якщо треба)
            logger.info("🔍 Checking if message form is open...");
            if (await page.locator('textarea#message').count() === 0) {
                const openBtns = [
                    'button:has-text("Відповісти")',
                    'button:has-text("Повідомлення")',
                    'a:has-text("Написати")',
                    '.js-respond-btn',
                    'button.tw-bg-blue-pacific-600:has-text("Відповісти")',
                    'button:has(svg use[href*="icon-reply"])'
                ];
                
                let btnClicked = false;
                for (const sel of openBtns) {
                    const btn = page.locator(sel).first();
                    if (await btn.count() > 0 && await btn.isVisible()) {
                        logger.info({ selector: sel }, "🔘 Clicking reply button...");
                        await btn.click();
                        btnClicked = true;
                        await page.waitForTimeout(2000);
                        break;
                    }
                }
                
                if (!btnClicked) {
                    logger.warn("⚠️ Could not find 'Reply' button, maybe form is already visible or UI is different");
                }
            }

            // 3. ВВІД ТЕКСТУ
            const textarea = page.locator('textarea#message, textarea[name="message"]').first();
            await textarea.waitFor({ state: 'visible', timeout: 15000 });
            await textarea.fill("");
            await page.keyboard.type(text, { delay: 30 });
            logger.info("✍️ Text typed");

            // 4. ВІДПРАВКА
            const sendBtn = page.locator('form button[type="submit"], button.tw-bg-blue-pacific-600').filter({ hasText: 'Надіслати' }).first();
            await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
            await sendBtn.click({ force: true });
            logger.info("✅ Send button clicked");

            await page.waitForTimeout(3000);
            await this.saveCookies(context);
            return true;
        } catch (e: any) {
            logger.error({ err: e.message }, "❌ Browser automation failed");
            return false;
        } finally {
            if (context) await context.close();
            if (this.browser) await this.browser.close();
        }
    }

    private async getAuthenticatedContext(): Promise<BrowserContext> {
        if (!this.browser) throw new Error("Browser not launched");
        
        const context = await this.browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1440, height: 900 },
            locale: 'uk-UA',
            timezoneId: 'Europe/Kyiv'
        });

        // 1. Спробуємо завантажити готові об'єкти cookies з Redis
        const cookiesStr = await redis.get(COOKIES_KEY);
        if (cookiesStr) {
            try {
                const cookies = JSON.parse(cookiesStr);
                await context.addCookies(cookies);
                logger.info("🍪 Loaded session cookies from Redis");
            } catch (e) {
                logger.error("❌ Failed to parse cookies from Redis");
            }
        }

        // 2. Додаємо підтримку сирого рядка Cookie (якщо є в .env)
        const rawCookie = process.env.WORK_UA_RAW_COOKIE;
        if (rawCookie) {
            const parsedCookies = rawCookie.split(';').map(pair => {
                const [name, ...valueParts] = pair.trim().split('=');
                return {
                    name: name || '',
                    value: valueParts.join('='),
                    domain: '.work.ua',
                    path: '/'
                };
            }).filter(c => c.name !== '');
            await context.addCookies(parsedCookies);
            logger.info("🔑 Injected raw session cookies from .env");
        }

        return context;
    }

    private async login(page: Page) {
        const email = process.env.WORK_UA_EMAIL;
        const password = process.env.WORK_UA_PASSWORD;
        if (!email || !password) throw new Error("Credentials missing");

        logger.info({ email }, "🔑 Logging in to Work.ua...");
        await page.goto(WORK_UA_LOGIN_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        
        // Клік на "Увійти" якщо це початкова сторінка (за вашим HTML)
        const bigBtn = page.locator('a:has-text("Увійти"), button:has-text("Увійти")').first();
        if (await bigBtn.isVisible() && !await page.locator('input[name="user_login"], input#user-login').isVisible()) {
            await bigBtn.click();
            await page.waitForTimeout(1000);
        }

        // Поле логіну (використовуємо точні назви з діагностики)
        const emailInput = page.locator('input[name="user_login"], input#user-login, input[name="email"]').first();
        const passwordInput = page.locator('input[name="password"], input#password').first();
        
        await emailInput.fill(email);
        await passwordInput.fill(password);
        await page.locator('button[type="submit"]').filter({ hasText: "Увійти" }).first().click();
        
        await page.waitForURL('**/employer/**', { timeout: 20000 });
        logger.info("🎉 Login successful");
    }

    private async saveCookies(context: BrowserContext) {
        const cookies = await context.cookies();
        await redis.set(COOKIES_KEY, JSON.stringify(cookies), 'EX', 60 * 60 * 24 * 7);
    }
}

export const workUABrowserService = new WorkUABrowserService();
