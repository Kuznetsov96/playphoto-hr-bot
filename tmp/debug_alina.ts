import prisma from "../src/db/core.js";
import { cryptoUtility } from "../src/core/crypto.js";

async function checkAlinaLogs() {
  const telegramId = BigInt(934423506); // @alinkr0
  const logs = await prisma.chatLog.findMany({
    where: { telegramId },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  console.log(`Found ${logs.length} logs for @alinkr0 (ID: ${telegramId})`);

  for (const log of logs) {
    console.log(`[${log.createdAt.toISOString()}] [${log.direction}] [${log.contentType}]`);
    // Note: Prisma extension already decrypts the data on read, so if we use our extended client, it's already decrypted.
    // However, if we're using a script that doesn't use the extended client, we'd need to manually decrypt.
    // Our 'src/db/core.ts' exports the EXTENDED client as 'prisma'.
    console.log(log.text);
    console.log("------------------------");
  }

  // Also check her shifts directly
  const staff = await prisma.staffProfile.findFirst({
    where: { user: { telegramId } },
    include: { shifts: { include: { location: true }, orderBy: { date: 'asc' } } }
  });

  if (staff) {
    console.log(`Staff Profile: ${staff.fullName} (ID: ${staff.id})`);
    console.log(`Shifts found: ${staff.shifts.length}`);
    for (const shift of staff.shifts) {
      console.log(`- ${shift.date.toLocaleDateString()} at ${shift.location.name}`);
    }
  } else {
    console.log("No staff profile found for @alinkr0");
  }
}

checkAlinaLogs()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
