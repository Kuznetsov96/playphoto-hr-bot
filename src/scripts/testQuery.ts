import prisma from "../db/core.js";

async function run() {
    try {
        const newHires = await prisma.staffProfile.findMany({
            where: { isWelcomeSent: false, isActive: true, shifts: { some: {} } },
            include: { user: true }
        });
        console.log("UNREACHABLE:", JSON.stringify(newHires.map(h => ({
            name: h.fullName,
            id: h.id,
            telegramId: h.user?.telegramId?.toString(),
            username: h.user?.username
        })), null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
