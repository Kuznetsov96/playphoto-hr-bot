import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const locationData = [
    { city: "Львів", name: "Leolend", address: "Львів, вул. Мельника 18", link: "https://maps.app.goo.gl/W2CXA78NjcfQwdUK9" },
    { city: "Львів", name: "Drive City", address: "Львів, вул. Сихівська 16а", link: "https://maps.app.goo.gl/R3KDthsMJngAkMUA9" },
    { city: "Львів", name: "Dragon Park", address: "Львів, вул. Стрийська 202а", link: "https://maps.app.goo.gl/8DbfprhNrj9K7ond7" },
    { city: "Львів", name: "Fly Kids Львів", address: "Львів, вул. Патона 37", link: "https://maps.app.goo.gl/1ENC3W26X7aD3Tmb6" },
    { city: "Львів", name: "Smile Park Lviv", address: "Львів, вул. Під Дубом, 7Б, ТРЦ Forum Lviv", link: "https://maps.app.goo.gl/3rksiH7LKtFDPzKYA" },
    { city: "Київ", name: "Smile Park Київ", address: "Київ, вул. Закревського, 22Т", link: "https://maps.app.goo.gl/FaeEDnJqLQcQ2qmX6" },
    { city: "Київ", name: "Smile Park (Darynok)", address: "Київ, вул. Якова Гніздовського, 1а, Маркет-молл Даринок", link: "https://maps.app.goo.gl/ySb4VHQ6WJYsJNkB8" },
    { city: "Київ", name: "Fly Kids Київ", address: "Київ, вул. Петра Вершигори, 1, ТЦ Дніпровський", link: "https://maps.app.goo.gl/3Dho3m8qAeTf6CaYA" },
    { city: "Запоріжжя", name: "Volkland 1", address: "Запоріжжя, Інженера Приображенського 13", link: "https://maps.app.goo.gl/YYzQwTZvfZA9wvee7" },
    { city: "Запоріжжя", name: "Volkland 2", address: "Запоріжжя, Чарівна 74 (ТЦ Амстор)", link: "https://maps.app.goo.gl/qNY9sKkm4EEMESzg8" },
    { city: "Запоріжжя", name: "Volkland 3", address: "Запоріжжя, вул. Перемоги 64, ТЦ Амстор", link: "https://maps.app.goo.gl/g81rhmmPfh1BHULL6" },
    { city: "Коломия", name: "Карамель Коломия", address: "Коломия, вул. Валова, 48 (ТЦ Прут)", link: "https://maps.app.goo.gl/PDoDo7Z8JibciaLx6" },
    { city: "Шептицький", name: "Карамель Шептицький", address: "Шептицький, вул. Богдана Хмельницького, 59", link: "https://maps.app.goo.gl/bYvtTGBRyQGFyqVT7" },
    { city: "Рівне", name: "Fly Kids Рівне", address: "Рівне, вул. Київська, 67А (ТЦ Арена)", link: "https://maps.app.goo.gl/f3Crv5vTj4ZKBskd7" },
    { city: "Черкаси", name: "Fantasy Town", address: "Черкаси, бульвар Шевченка, 385, ТРЦ DEPO't", link: "https://maps.app.goo.gl/AjfLf3S3RpyEeZm28" },
    { city: "Харків", name: "Smile Park Kharkiv", address: "Харків, вул. Григорія Сковороди, 2а, ТРЦ Nikolsky", link: "https://maps.app.goo.gl/zhHTbJd9sK8Cxh1B6" },
    { city: "Самбір", name: "Karamel Sambir", address: "Самбір, вулиця Торгова, 62", link: "https://maps.app.goo.gl/yoZ2DYf7bGbzBhzq5" },
    { city: "Хмельницький", name: "Dytyache Horyshche", address: "Хмельницький, проспект Миру, 99/101", link: "https://maps.app.goo.gl/tUXCRKMHb6qxnEPk9" }
];

async function main() {
    console.log("🚀 Starting locations metadata update (standalone)...");
    const dbLocs = await prisma.location.findMany();
    let updated = 0;

    for (const data of locationData) {
        const match = dbLocs.find(l => {
            const lName = l.name.toLowerCase();
            const dName = data.name.toLowerCase();
            // Match if one name contains another
            const nameMatch = lName.includes(dName) || dName.includes(lName) || 
                             (l.legacyName || "").toLowerCase().includes(dName);
            const cityMatch = l.city === data.city;
            return nameMatch && cityMatch;
        });

        if (match) {
            await prisma.location.update({
                where: { id: match.id },
                data: {
                    address: data.address,
                    googleMapsLink: data.link
                }
            });
            console.log(`✅ Updated: ${match.name} (${match.city})`);
            updated++;
        } else {
            console.log(`❌ NOT FOUND in DB: ${data.name} in ${data.city}`);
        }
    }

    console.log(`\n🎉 Finished! Updated ${updated} of ${locationData.length} locations.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
