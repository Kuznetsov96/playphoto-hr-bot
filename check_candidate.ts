import prisma from './src/db/core.js';

async function main() {
  // Search by username @anna_maryy
  const user = await prisma.user.findFirst({
    where: { username: 'anna_maryy' },
    include: {
      candidate: {
        include: {
          location: true,
          firstShiftPartner: true,
        }
      }
    }
  });

  if (!user || !user.candidate) {
    // Fallback: search by name
    const candidates = await prisma.candidate.findMany({
      where: { fullName: { contains: 'Охрін', mode: 'insensitive' } },
      include: { user: true, location: true, firstShiftPartner: true }
    });
    if (candidates.length === 0) {
      console.log("Candidate not found by username or name.");
      return;
    }
    for (const c of candidates) {
      printCandidate(c, c.user);
    }
    return;
  }

  printCandidate(user.candidate, user);
}

function printCandidate(c: any, user: any) {
  console.log('=== CANDIDATE INFO ===');
  console.log(`Name: ${c.fullName || '❌ NOT SET'}`);
  console.log(`Username: @${user?.username || '?'}`);
  console.log(`TelegramId: ${user?.telegramId}`);
  console.log(`Status: ${c.status}`);
  console.log(`Current Step: ${c.currentStep}`);
  console.log(`Location: ${c.location?.name || c.city || '❌ NOT SET'}`);
  console.log(`City: ${c.city || '❌ NOT SET'}`);
  console.log('');
  console.log('=== PERSONAL DATA ===');
  console.log(`Phone: ${c.phone || '❌ NOT SET'}`);
  console.log(`Birth Date: ${c.birthDate || '❌ NOT SET'}`);
  console.log(`Gender: ${c.gender || '❌ NOT SET'}`);
  console.log(`Email: ${c.email || '❌ NOT SET'}`);
  console.log(`Instagram: ${c.instagram || '❌ NOT SET'}`);
  console.log('');
  console.log('=== ONBOARDING DATA ===');
  console.log(`IBAN: ${c.iban ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`Passport Number: ${c.passportNumber ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`Passport Issued At: ${c.passportIssuedAt || '❌ NOT SET'}`);
  console.log(`Passport Issued By: ${c.passportIssuedBy ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`IPN (tax): ${c.ipn ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`Registration Address: ${c.registrationAddress ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`Bank Card: ${c.bankCard ? '✅ SET' : '❌ NOT SET'}`);
  console.log(`Passport Photos: ${c.passportPhotoIds ? '✅ SET' : '❌ NOT SET'}`);
  console.log('');
  console.log('=== NDA & DECISIONS ===');
  console.log(`NDA Confirmed At: ${c.ndaConfirmedAt || '❌ NOT CONFIRMED'}`);
  console.log(`NDA Sent At: ${c.ndaSentAt || '❌ NOT SENT'}`);
  console.log(`HR Decision: ${c.hrDecision || 'NONE'}`);
  console.log(`Candidate Decision: ${c.candidateDecision || 'NONE'}`);
  console.log('');
  console.log('=== TIMELINE ===');
  console.log(`Created At: ${c.createdAt}`);
  console.log(`Updated At: ${c.updatedAt}`);
  console.log(`Interview Completed At: ${c.interviewCompletedAt || '-'}`);
  console.log(`Discovery Completed At: ${c.discoveryCompletedAt || '-'}`);
  console.log(`Training Completed At: ${c.trainingCompletedAt || '-'}`);
  console.log(`First Shift Date: ${c.firstShiftDate || '-'}`);
  console.log(`First Shift Partner: ${c.firstShiftPartner?.fullName || '-'}`);
  console.log(`Quiz Score: ${c.quizScore ?? '-'}`);
  console.log(`Test Passed: ${c.testPassed ?? '-'}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
