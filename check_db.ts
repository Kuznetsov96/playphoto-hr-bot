import prisma from './src/db/core.js';
import { CandidateStatus } from '@prisma/client';

async function main() {
  const bookedSlots = await prisma.interviewSlot.findMany({
    where: { isBooked: true },
    include: { candidate: true },
    orderBy: { startTime: 'asc' }
  });

  console.log("=== BOOKED SLOTS ===");
  bookedSlots.forEach(s => {
    console.log(`Slot: ${s.startTime.toISOString()} | Candidate: ${s.candidate?.fullName} | Status: ${s.candidate?.status} | Decision: ${s.candidate?.hrDecision}`);
  });

  const scheduledCandidates = await prisma.candidate.findMany({
    where: { status: CandidateStatus.INTERVIEW_SCHEDULED },
    include: { interviewSlot: true }
  });

  console.log("\n=== CANDIDATES WITH INTERVIEW_SCHEDULED STATUS ===");
  scheduledCandidates.forEach(c => {
    console.log(`Candidate: ${c.fullName} | Slot: ${c.interviewSlot?.startTime?.toISOString() || 'NONE'}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
