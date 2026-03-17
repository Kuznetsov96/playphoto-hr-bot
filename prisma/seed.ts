import { PrismaClient } from '@prisma/client';
import * as dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();

const locations = [
    // --- КИЇВ ---
    {
        city: 'Київ',
        name: 'Smile Park Київ №1',
        name_db: 'Smile Park Київ', // Keeping original name if possible
        address_db: 'Київ, вул. Закревського, 22Т',
        sheet: 'SP Київ',
        schedule: "Пн-Пт — 15:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 25%\nСб-Нд — 2 человека 20%, 1 человек — 30%"
    },
    {
        city: 'Київ',
        name: 'Smile Park (Даринок)',
        name_db: 'Smile Park (Даринок)',
        address_db: 'Київ, вул. Якова Гніздовського, 1а (Маркет-молл "Даринок")',
        sheet: 'SP Даринок',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 20%\nСб-Нд — 2 человека 20%, 1 человек — 30%"
    },
    {
        city: 'Київ',
        name: 'Fly Kids Київ (Дніпровський)',
        name_db: 'Fly Kids Київ (Дніпровський)', // Distinct from Promenada
        address_db: 'Київ, вул. Петра Вершигори, 1 (ТЦ «Дніпровський»)',
        sheet: 'FK Київ',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },

    // --- ЛЬВІВ ---
    {
        city: 'Львів',
        name: 'Leolend',
        name_db: 'Leolend',
        address_db: 'Львів, вул. Мельника 18',
        sheet: 'Leoland',
        schedule: "Пн-Пт — 15:00-21:00\nСб-Нд — 10:00-21:00",
        salary: "Пн-Пт — 1 человек 25%\nСб-Нд — 2 человека 18%, 1 человек — 30%"
    },
    {
        city: 'Львів',
        name: 'Drive City',
        name_db: 'Drive City',
        address_db: 'Львів, вул. Сихівська 16а',
        sheet: 'DriveCity',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 12:00-20:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },
    {
        city: 'Львів',
        name: 'Dragon Park',
        name_db: 'Dragon Park',
        address_db: 'Львів, вул. Стрийська 202а',
        sheet: 'DragonP',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 20%\nСб-Нд — 2 человека 18%, 1 человек — 30%"
    },
    {
        city: 'Львів',
        name: 'Fly Kids Львів',
        name_db: 'Fly Kids Львів',
        address_db: 'Львів, вул. Патона 37',
        sheet: 'FK Львів',
        schedule: "Пн-Пт — 15:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Нд — один фотограф по 25%"
    },
    {
        city: 'Львів',
        name: 'Smile Park Lviv',
        name_db: 'Smile Park Lviv',
        address_db: 'Львів, вул. Під Дубом, 7Б, ТРЦ «Forum Lviv»',
        sheet: 'SP Львів',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 20%, Сб-Нд — 1 человек 30%"
    },

    // --- ЗАПОРІЖЖЯ ---
    {
        city: 'Запоріжжя',
        name: 'Volkland (Бабурка)',
        name_db: 'Volkland 1 (Бабурка)',
        address_db: 'Запоріжжя, вул. Інженера Преображенського 13',
        sheet: 'Volkland',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 11:00-21:00",
        salary: "Пн-Нд — один фотограф по 25%"
    },
    {
        city: 'Запоріжжя',
        name: 'Volkland (Шевчик)',
        name_db: 'Volkland 2 (Шевчик)',
        address_db: 'Запоріжжя, вул. Чарівна 74 (ТЦ Амстор)',
        sheet: 'Volkland 2',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },
    {
        city: 'Запоріжжя',
        name: 'Volkland 3',
        name_db: 'Volkland 3 (Перемоги)',
        address_db: 'Запоріжжя, вул. Перемоги 64',
        sheet: 'Volkland 3',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },

    // --- ІНШІ ---
    {
        city: 'Коломия',
        name: 'Карамель Коломия',
        name_db: 'Карамель Коломия',
        address_db: 'Коломия, вул. Валова, 48 (ТЦ Прут)',
        sheet: 'Карамель К',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 12:00-20:00",
        salary: "Пн-Нд — один фотограф по 25%"
    },
    {
        city: 'Шептицький',
        name: 'Карамель Шептицький',
        name_db: 'Карамель Шептицький',
        address_db: 'Шептицький, вул. Богдана Хмельницького, 59',
        sheet: 'Карамель Ч',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 12:00-20:00",
        salary: "Пн-Нд — один фотограф по 25%"
    },
    {
        city: 'Рівне',
        name: 'Fly Kids Рівне',
        name_db: 'Fly Kids Рівне',
        address_db: 'Рівне, вул. Київська, 67А (ТЦ "Арена")',
        sheet: 'FK Рівне',
        schedule: "Пн-Пт — 15:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },
    {
        city: 'Черкаси',
        name: 'Fantasy Town',
        name_db: 'Fantasy Town',
        address_db: "Черкаси, бульвар Шевченка, 385, ТРЦ DEPO't",
        sheet: 'FT Черкаси',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Нд — один фотограф по 30%"
    },
    {
        city: 'Харків',
        name: 'Smile Park Kharkiv',
        name_db: 'Smile Park Kharkiv',
        address_db: 'Харків, вул. Григорія Сковороди, 2а, ТРЦ «Nikolsky»',
        sheet: 'SP Харків',
        schedule: "Пн-Пт — 14:00-21:00\nСб-Нд — 12:00-21:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },
    {
        city: 'Самбір',
        name: 'Карамель Самбір',
        name_db: 'Karamel Sambir', // Match previous name or user provided "Карамель Самбір"
        address_db: 'Самбір, вул. Торгова, 62 (ТЦ «Атлант»)',
        sheet: 'Карамель С',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 12:00-20:00",
        salary: "Пн-Пт — 1 человек 25%, Сб-Нд — 1 человек 30%"
    },
    {
        city: 'Хмельницький',
        name: 'Дитяче Горище',
        name_db: 'Dytyache Horyshche',
        address_db: 'Хмельницький, проспект Миру, 99/101',
        sheet: 'DH Khmelnytskyi',
        schedule: "Пн-Пт — 14:00-20:00\nСб-Нд — 12:00-20:00",
        salary: "Пн-Нд — один фотограф по 30%"
    }
];

function getGoogleMapsLink(address: string): string {
    const query = encodeURIComponent(address);
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

async function main() {
    console.log('🌱 Починаємо заповнення локацій...');

    for (const loc of locations) {
        const mapsLink = getGoogleMapsLink(loc.address_db);

        // We will store just the raw address in 'address' field?
        // User asked for "address" field update in previous step.
        // But now we have fields 'googleMapsLink', 'schedule', 'salary'.
        // So 'address' should be clean address.

        const existing = await prisma.location.findFirst({
            where: { name: loc.name_db }
        });

        if (existing) {
            await prisma.location.update({
                where: { id: existing.id },
                data: {
                    city: loc.city,
                    address: loc.address_db,
                    googleMapsLink: mapsLink,
                    schedule: loc.schedule,
                    salary: loc.salary,
                    sheet: loc.sheet
                }
            });
        } else {
            await prisma.location.create({
                data: {
                    name: loc.name_db,
                    city: loc.city,
                    address: loc.address_db,
                    googleMapsLink: mapsLink,
                    schedule: loc.schedule,
                    salary: loc.salary,
                    sheet: loc.sheet
                }
            });
        }
    }

    console.log(`✅ Оброблено ${locations.length} локацій!`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
