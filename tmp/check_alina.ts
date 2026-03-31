import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({
    where: { username: 'alinkr0' },
    include: { staffProfile: true }
  });

  if (!user) {
    console.log('User @alinkr0 not found');
    return;
  }

  console.log('User found:', {
    id: user.id,
    telegramId: user.telegramId.toString(),
    staffProfileId: user.staffProfile?.id,
    fullName: user.staffProfile?.fullName
  });

  if (user.staffProfile) {
    const shifts = await prisma.workShift.findMany({
      where: { staffId: user.staffProfile.id, date: { gte: new Date('2026-04-01') } },
      include: { location: true },
      orderBy: { date: 'asc' }
    });
    console.log(`Found ${shifts.length} shifts for 2026-04+:`);
    shifts.forEach(s => {
      console.log(`${s.date.toISOString()} - ${s.location.name}`);
    });
  }
}

main().finally(() => prisma.$disconnect());
