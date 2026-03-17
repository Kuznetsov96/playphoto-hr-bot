import { monoClients } from "./src/services/finance/monobank.js";
import { redis } from "./src/core/redis.js";

async function run() {
    console.log("Fetching client info for Karpuk...");
    const client = monoClients.karpuk;

    try {
        const info = await client.getClientInfo();
        console.log("Client Name:", info.name);
        console.log("Total Accounts:", info.accounts.length);

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
    } finally {
        redis.quit();
    }
}
run();
