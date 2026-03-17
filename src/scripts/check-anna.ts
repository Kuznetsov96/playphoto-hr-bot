
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkCandidate() {
  try {
    const user = await prisma.user.findFirst({
      where: { username: 'anna_maryy' },
      include: {
        candidate: {
          include: {
            interviewSlot: true
          }
        }
      }
    });

    if (!user) {
      console.log("Кандидатку з юзернеймом @anna_maryy не знайдено.");
      return;
    }

    const cand = user.candidate;
    if (!cand) {
      console.log("Користувач знайдений, але він не зареєстрований як кандидат.");
      return;
    }

    console.log(`Кандидатка: ${cand.fullName}`);
    console.log(`Статус: ${cand.status}`);
    console.log(`Рішення HR: ${cand.hrDecision || 'Не прийнято'}`);
    
    if (cand.interviewSlot) {
      console.log(`Співбесіда: ${cand.interviewSlot.startTime}`);
      console.log(`Заброньовано: ${cand.interviewSlot.isBooked ? 'Так' : 'Ні'}`);
    } else {
      console.log("Слот для співбесіди не знайдено.");
    }
    
    if (cand.interviewCompletedAt) {
      console.log(`Співбесіда проведена: ${cand.interviewCompletedAt}`);
    } else {
      console.log("Дати завершення співбесіди немає.");
    }

  } catch (error) {
    console.error("Помилка при запиті до БД:", error);
  } finally {
    await prisma.$disconnect();
  }
}

checkCandidate();
