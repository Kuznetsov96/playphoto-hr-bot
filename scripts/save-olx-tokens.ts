import prisma from "../src/db/core.js";

async function saveTokens() {
    const accessToken = "***REDACTED-OLX-ACCESS-TOKEN***";
    const refreshToken = "***REDACTED-OLX-REFRESH-TOKEN***";
    const expiresIn = 86348;

    console.log("⏳ Saving OLX tokens to database...");
    
    try {
        await prisma.externalToken.upsert({
            where: { service: "OLX" },
            create: {
                service: "OLX",
                accessToken: accessToken,
                refreshToken: refreshToken,
                expiresAt: new Date(Date.now() + expiresIn * 1000)
            },
            update: {
                accessToken: accessToken,
                refreshToken: refreshToken,
                expiresAt: new Date(Date.now() + expiresIn * 1000)
            }
        });

        console.log("✅ OLX tokens successfully saved to DB!");
        console.log("🚀 You can now start the bot.");
    } catch (e: any) {
        console.error("❌ Error saving to database:", e.message);
    }
}

saveTokens();
