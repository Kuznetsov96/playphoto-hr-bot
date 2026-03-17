/**
 * Скрипт для отримання OAuth refresh токенів з calendar scope.
 * Запускати: npx tsx scripts/get_calendar_tokens.ts
 *
 * ВАЖЛИВО: Посилання потрібно відкривати на ЦЬОМУ ж комп'ютері де запущений скрипт.
 * HR і Ментор мають залогінитись у браузері на цьому комп'ютері своїм акаунтом.
 */

import { google } from "googleapis";
import * as readline from "readline";
import * as dotenv from "dotenv";
import * as http from "http";
import * as url from "url";

dotenv.config();

const SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
];

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Можна передати кастомний redirect URI через змінну середовища:
// REDIRECT_URI=https://abc123.ngrok-free.app/oauth2callback npx tsx scripts/get_calendar_tokens.ts
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:3737/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ GOOGLE_CLIENT_ID або GOOGLE_CLIENT_SECRET не знайдені в .env");
    process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

async function getTokenViaLocalServer(label: string): Promise<string> {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
    });

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  Авторизація: ${label}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`\n📋 Інструкція:`);
    console.log(`   1. Відкрий браузер на ЦЬОМУ комп'ютері`);
    console.log(`   2. Якщо потрібно — переключись на акаунт ${label}`);
    console.log(`      (натисни фото профілю → "Додати акаунт" або "Переключитись")`);
    console.log(`   3. Відкрий це посилання:\n`);
    console.log(`   ${authUrl}\n`);
    console.log(`   4. Натисни "Дозволити"`);
    console.log(`   5. Браузер покаже "Авторизацію завершено" — повернись сюди\n`);

    await ask(`Натисни Enter після того як відкрив посилання в браузері...`);

    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const parsedUrl = url.parse(req.url || "", true);
            const code = parsedUrl.query.code as string;

            if (!code) {
                res.end("❌ Код не знайдено. Закрий і спробуй ще раз.");
                return;
            }

            res.end(`
                <html><body style="font-family:sans-serif;padding:40px;background:#1a1a2e;color:#eee">
                <h2 style="color:#4CAF50">✅ Авторизацію завершено!</h2>
                <p>Можеш закрити це вікно і повернутись до терміналу.</p>
                </body></html>
            `);

            server.close();

            try {
                const { tokens } = await oAuth2Client.getToken(code);
                oAuth2Client.setCredentials(tokens);

                if (!tokens.refresh_token) {
                    reject(new Error(
                        "refresh_token не повернувся.\n" +
                        "Відкрий https://myaccount.google.com/permissions\n" +
                        "→ знайди 'HR Bot' → 'Видалити доступ' → запусти скрипт знову."
                    ));
                    return;
                }

                resolve(tokens.refresh_token);
            } catch (err: any) {
                reject(new Error(`Помилка: ${err.message}`));
            }
        });

        server.listen(3737, "localhost");
        server.on("error", (err: any) => {
            reject(new Error(`Порт 3737 зайнятий: ${err.message}`));
        });
    });
}

async function verifyToken(refreshToken: string, label: string) {
    const testClient = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    testClient.setCredentials({ refresh_token: refreshToken });

    try {
        const { credentials } = await testClient.refreshAccessToken();
        const tokenInfo = await fetch(
            `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${credentials.access_token}`
        ).then(r => r.json()) as any;

        console.log(`\n✅ Токен ${label} валідний`);
        console.log(`   Email: ${tokenInfo.email || "(не визначено)"}`);

        if (!tokenInfo.scope?.includes("calendar")) {
            console.warn(`   ⚠️  Calendar scope відсутній!`);
        } else {
            console.log(`   ✅ Calendar scope підтверджено`);
        }
    } catch (e: any) {
        console.error(`\n❌ Перевірка токену не вдалася: ${e.message}`);
    }
}

async function main() {
    console.log("=".repeat(60));
    console.log("  PlayPhoto HR Bot — Отримання Calendar OAuth токенів");
    console.log("=".repeat(60));
    console.log("\n⚠️  ВАЖЛИВО: Посилання відкривай на ЦЬОМУ комп'ютері.");
    console.log("   HR і Ментор мають авторизуватись через браузер тут.");

    // --- HR Token ---
    let hrToken: string;
    try {
        hrToken = await getTokenViaLocalServer("HR (HR email акаунт)");
        console.log("\n✅ HR токен отримано!");
        await verifyToken(hrToken, "HR");
    } catch (e: any) {
        console.error(`\n❌ Помилка: ${e.message}`);
        rl.close();
        process.exit(1);
    }

    // --- Mentor Token ---
    let mentorToken: string;
    try {
        mentorToken = await getTokenViaLocalServer("Ментора (акаунт Марії)");
        console.log("\n✅ Mentor токен отримано!");
        await verifyToken(mentorToken, "Mentor");
    } catch (e: any) {
        console.error(`\n❌ Помилка: ${e.message}`);
        rl.close();
        process.exit(1);
    }

    // --- Summary ---
    console.log("\n" + "=".repeat(60));
    console.log("  ГОТОВО! Вставляй в .env:");
    console.log("=".repeat(60));
    console.log(`\nGOOGLE_REFRESH_TOKEN=${hrToken}`);
    console.log(`MENTOR_REFRESH_TOKEN=${mentorToken}\n`);
    console.log("Після оновлення .env — перезапусти бота.");
    console.log("=".repeat(60));

    rl.close();
}

main().catch(err => {
    console.error("Критична помилка:", err);
    process.exit(1);
});
