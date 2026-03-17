import { MONO_TOKENS } from "./src/config.js";
import fetch from "node-fetch";

async function run() {
    const token = MONO_TOKENS.KARPUK;
    console.log("Token exists:", !!token);
    if (!token) {
        console.log("No Karpuk token found in config.");
        return;
    }

    try {
        const response = await fetch("https://api.monobank.ua/personal/client-info", {
            headers: { "X-Token": token }
        });

        if (!response.ok) {
            console.error("HTTP Error:", response.status, await response.text());
            return;
        }

        const info = await response.json() as any;
        console.log("Client Name:", info.name);

        info.accounts.forEach((acc: any, i: number) => {
            console.log(`\nAccount ${i + 1}:`);
            console.log(" - ID:", acc.id);
            console.log(" - IBAN:", acc.iban);
            console.log(" - Currency:", acc.currencyCode);
            console.log(" - Balance:", acc.balance / 100);
            console.log(" - Type:", acc.type);
        });
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}
run();
