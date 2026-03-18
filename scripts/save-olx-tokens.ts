import prisma from "../src/db/core.js";

async function saveTokens() {
    const accessToken = process.argv[2];
    const refreshToken = process.argv[3];
    const expiresIn = Number(process.argv[4] || 86348);

    if (!accessToken || !refreshToken) {
        console.error("Usage: npx tsx scripts/save-olx-tokens.ts <accessToken> <refreshToken> [expiresIn]");
        process.exit(1);
    }

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
