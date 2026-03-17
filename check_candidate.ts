import prisma from './src/db/core.js';
import { CandidateStatus } from '@prisma/client';

async function main() {
  const name = "Анна Охрін";
  console.log(`Searching for: ${name}...`);

  const candidates = await prisma.candidate.findMany({
    where: {
        fullName: { contains: name, mode: 'insensitive' }
    },
    include: {
        user: true,
        firstShiftPartner: true
    }
  });

  if (candidates.length === 0) {
      console.log("Candidate not found.");
  }

  for (const c of candidates) {
    console.log(`\nCandidate: ${c.fullName}`);
    console.log(`Status: ${c.status}`);
    console.log(`Partner: ${c.firstShiftPartner?.fullName || 'None'}`);
    console.log(`Notification Sent: ${c.notificationSent}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
