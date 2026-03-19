
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting data fixes...');

  // 1. Deactivate non-photographers
  const namesToDeactivate = [
    'Кузнецов Віталій Олегович',
    'Гупалова Альона',
    'Гудим Анна Любомирівна'
  ];

  const updateResult = await prisma.staffProfile.updateMany({
    where: {
      fullName: { in: namesToDeactivate }
    },
    data: {
      isActive: false
    }
  });

  console.log(`Deactivated ${updateResult.count} staff members.`);

  // 2. Find shifts for Готра
  const gotraFullName = 'Готра Марія-Анастасія Вячеславівна';
  const gotra = await prisma.staffProfile.findFirst({
    where: { fullName: gotraFullName }
  });

  if (!gotra) {
    console.error(`Staff member not found: ${gotraFullName}`);
    return;
  }

  console.log(`Found Готра ID: ${gotra.id}`);

  const shifts = await prisma.workShift.findMany({
    where: { staffId: gotra.id },
    orderBy: { date: 'asc' },
    include: {
      location: true
    }
  });

  console.log('Current shifts for Готра:');
  shifts.forEach(shift => {
    console.log(`ID: ${shift.id}, Date: ${shift.date.toISOString()}, Location: ${shift.location.name}`);
  });

  // 3. Fix shift on 18.03
  const targetDate = new Date('2026-03-18T00:00:00.000Z');
  const shiftToFix = shifts.find(s => {
      const sDate = new Date(s.date);
      return sDate.getFullYear() === 2026 && sDate.getMonth() === 2 && sDate.getDate() === 18;
  });

  if (shiftToFix) {
    console.log(`Found shift to fix on 18.03: ${shiftToFix.id}`);
    
    // Update it to 21.03
    const updatedShift = await prisma.workShift.update({
      where: { id: shiftToFix.id },
      data: {
        date: new Date('2026-03-21T00:00:00.000Z')
      }
    });
    console.log(`Updated shift ${shiftToFix.id} to 21.03.`);
  } else {
    console.log('No shift found on 18.03 for Готра.');
  }

  // 4. Verification
  const finalShifts = await prisma.workShift.findMany({
    where: { staffId: gotra.id },
    orderBy: { date: 'asc' },
    include: {
        location: true
    }
  });

  console.log('Final shifts for Готра:');
  finalShifts.forEach(shift => {
    console.log(`ID: ${shift.id}, Date: ${shift.date.toISOString()}, Location: ${shift.location.name}`);
  });
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
