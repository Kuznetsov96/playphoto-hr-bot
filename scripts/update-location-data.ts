import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const locationData = [
  {
    name: "Leolend",
    address: "Львів, вул. Мельника 18",
    schedule: "Пн-Пт — 15:00-21:00, Сб-Нд — 10:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 2 человека 18%, 1 человек — 30%"
  },
  {
    name: "Drive City",
    address: "Львів, вул. Сихівська 16а",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 12:00-20:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Dragon Park",
    address: "Львів, вул. Стрийська 202а",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 20%, Сб-Нд — 2 человека 18%, 1 человек — 30%"
  },
  {
    name: "Карамель Коломия",
    address: "Коломия, вул. Валова, 48 (ТЦ Прут)",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 12:00-20:00",
    salary: "Пн-Нд — один фотограф по 25%"
  },
  {
    name: "Карамель Шептицький",
    address: "Шептицький, вул. Богдана Хмельницького, 59",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 12:00-20:00",
    salary: "Пн-Нд — один фотограф по 25%"
  },
  {
    name: "Smile Park Київ",
    address: "Київ, вул. Закревського, 22Т",
    schedule: "Пн-Пт — 15:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 2 человека 20%, 1 человек — 30%"
  },
  {
    name: "Fly Kids Львів",
    address: "Львів, вул. Патона 37",
    schedule: "Пн-Пт — 15:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Нд — один фотограф по 25%"
  },
  {
    name: "Volkland (Бабурка) Запоріжжя",
    address: "Запоріжжя, Інженера Приображенського 13",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 11:00-21:00",
    salary: "Пн-Нд — один фотограф по 25%"
  },
  {
    name: "Smile Park (Даринок) Київ",
    address: "Київ, вул. Якова Гніздовського, 1а, Маркет-молл Даринок",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 20%, Сб-Нд — 2 человека 20%, 1 человек — 30%"
  },
  {
    name: "Fly Kids Київ",
    address: "Київ, вул. Петра Вершигори, 1, ТЦ Дніпровський",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Fly Kids Рівне",
    address: "Рівне, вул. Київська, 67А (ТЦ Арена)",
    schedule: "Пн-Пт — 15:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Fantasy Town Черкаси",
    address: "Черкаси, бульвар Шевченка, 385, ТРЦ DEPOT",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Нд — один фотограф по 30%"
  },
  {
    name: "Smile Park Харків",
    address: "Харків, вул. Григорія Сковороди, 2а, ТРЦ Nikolsky",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Volkland (Шевчик) Запоріжжя",
    address: "Запоріжжя, Чврівна 74 (ТЦ Амстор)",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Volkland 3 Запоріжжя",
    address: "Запоріжжя, Перемоги 64",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Smile Park Lviv",
    address: "Львів, вул. Під Дубом, 7Б, ТРЦ Forum Lviv",
    schedule: "Пн-Пт — 14:00-21:00, Сб-Нд — 12:00-21:00",
    salary: "Пн-Пт — 1 человек 20%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Карамель Самбір",
    address: "Самбір, ТЦ Атлант, вулиця Торгова, 62",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 12:00-20:00",
    salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
  },
  {
    name: "Дитяче Горище, Хмельницький",
    address: "Хмельницький, проспект Миру 99/101",
    schedule: "Пн-Пт — 14:00-20:00, Сб-Нд — 12:00-20:00",
    salary: "Пн-Нд — один фотограф по 30%"
  }
];

async function main() {
  console.log('🚀 Starting location data update...');
  
  for (const data of locationData) {
    try {
      const result = await prisma.location.updateMany({
        where: {
          OR: [
            { name: { contains: data.name } },
            { legacyName: { contains: data.name } }
          ]
        },
        data: {
          address: data.address,
          schedule: data.schedule,
          salary: data.salary
        }
      });
      
      if (result.count > 0) {
        console.log(`✅ Updated ${data.name} (${result.count} entries)`);
      } else {
        console.warn(`⚠️ Location NOT FOUND: ${data.name}`);
      }
    } catch (error) {
      console.error(`❌ Error updating ${data.name}:`, error);
    }
  }
  
  console.log('✨ Update finished!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
