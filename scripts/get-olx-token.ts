import * as dotenv from "dotenv";
dotenv.config();

import { OLX_CONFIG } from "../src/config.js";
import fetch from "node-fetch";

async function getTokens() {
    const code = process.argv[2];
    if (!code) {
        console.error("Usage: npx tsx scripts/get-olx-token.ts <authorization_code>");
        process.exit(1);
    }
    
    try {
        const response = await fetch("https://www.olx.ua/api/open/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "authorization_code",
                client_id: OLX_CONFIG.CLIENT_ID,
                client_secret: OLX_CONFIG.CLIENT_SECRET,
                code: code,
                redirect_uri: OLX_CONFIG.REDIRECT_URI,
                scope: "read write v2"
            })
        });

        const data: any = await response.json();

        if (!response.ok) {
            console.error("❌ Failed to get tokens:", data);
            return;
        }

        console.log("✅ Tokens received successfully!");
        console.log("-----------------------------------------");
        console.log("ACCESS_TOKEN:", data.access_token);
        console.log("REFRESH_TOKEN:", data.refresh_token);
        console.log("EXPIRES_IN:", data.expires_in);
        console.log("-----------------------------------------");
    } catch (e: any) {
        console.error("❌ Error during token exchange:", e.message);
    }
}

getTokens();
