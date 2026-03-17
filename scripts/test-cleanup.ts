import prisma from "../src/db/core.js";
import { supportRepository } from "../src/repositories/support-repository.js";
import { TicketStatus } from "@prisma/client";

async function testCleanup() {
    console.log("🚀 Starting cleanup verification test...");

    // 1. Find or create a user for testing
    let user = await prisma.user.findFirst({
        where: { staffProfile: { isNot: null } }
    });

    if (!user) {
        console.error("❌ No user with staff profile found for testing!");
        process.exit(1);
    }

    console.log(`👤 Using user: ${user.firstName || user.id}`);

    // 2. Create a "stale" ticket (updated 3 days ago)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Prisma's create doesn't allow setting updatedAt manually usually if it's auto-managed,
    // but we can update it immediately after.
    const ticket = await prisma.supportTicket.create({
        data: {
            userId: user.id,
            issueText: "Verification Test Ticket (Stale)",
            status: TicketStatus.OPEN,
            createdAt: threeDaysAgo,
            updatedAt: threeDaysAgo
        }
    });

    console.log(`🎫 Created stale ticket #${ticket.id}, updatedAt: ${ticket.updatedAt}`);

    // 3. Verify findStaleTickets
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const staleTickets = await supportRepository.findStaleTickets(cutoff);
    const found = staleTickets.find(t => t.id === ticket.id);

    if (found) {
        console.log("✅ findStaleTickets correctly identified the stale ticket.");
    } else {
        console.error("❌ findStaleTickets FAILED to find the stale ticket!");
    }

    // 4. Clean up test data (optional, or leave for manual check)
    // await prisma.supportTicket.delete({ where: { id: ticket.id } });

    console.log("🏁 Test completed.");
}

testCleanup()
    .catch(err => {
        console.error("💥 Test failed with error:", err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
