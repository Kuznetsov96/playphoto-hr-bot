import prisma from "./src/db/core.js";

async function checkCandidates() {
  const startOfIncident = new Date("2026-03-31T08:25:00Z");
  const endOfIncident = new Date("2026-03-31T08:44:00Z");

  console.log(`Checking candidates with statusChangedAt before ${startOfIncident.toISOString()}`);

  const candidates = await prisma.candidate.findMany({
    where: {
      statusChangedAt: {
        lt: startOfIncident,
        gt: new Date("2026-03-30T00:00:00Z") // Changed since yesterday to narrow down
      }
    },
    include: {
      user: true
    },
    orderBy: {
      statusChangedAt: 'desc'
    }
  });

  console.log(`Found ${candidates.length} candidates changed between yesterday and the incident.`);
  
  candidates.forEach(c => {
    console.log(`- [${c.statusChangedAt?.toISOString()}] ${c.fullName || 'Unknown'} (ID: ${c.id}, Status: ${c.status})`);
  });

  // Also let's see how many were changed DURING the incident
  const duringIncident = await prisma.candidate.count({
    where: {
      statusChangedAt: {
        gte: startOfIncident,
        lte: endOfIncident
      }
    }
  });
  console.log(`\nCandidates changed DURING incident (08:25-08:44): ${duringIncident}`);

  await prisma.$disconnect();
}

checkCandidates().catch(console.error);
