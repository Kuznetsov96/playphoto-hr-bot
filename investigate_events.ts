import prisma from "./src/db/core.js";

async function investigate() {
  const startOfIncident = new Date("2026-03-31T08:25:00Z");
  
  console.log(`Searching for status change events before ${startOfIncident.toISOString()}...`);

  try {
    const events = await prisma.userTimelineEvent.findMany({
      where: {
        type: "STATUS_CHANGE",
        createdAt: {
          lt: startOfIncident,
          gt: new Date("2026-03-30T00:00:00Z")
        }
      },
      include: {
        user: {
          include: {
            candidate: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    console.log(`Found ${events.length} status change events between yesterday and incident.`);
    events.forEach(e => {
      console.log(`- [${e.createdAt.toISOString()}] User: ${e.user.candidate?.fullName || e.user.username || e.user.telegramId} | Event: ${e.text}`);
    });

    // Check if there are ANY events today at all
    const anyToday = await prisma.userTimelineEvent.count({
      where: {
        createdAt: {
          gt: new Date("2026-03-31T00:00:00Z")
        }
      }
    });
    console.log(`\nTotal events recorded today (March 31): ${anyToday}`);

  } catch (error) {
    console.error("❌ Investigation failed:", error);
  }

  await prisma.$disconnect();
}

investigate();
