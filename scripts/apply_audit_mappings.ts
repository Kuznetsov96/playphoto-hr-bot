import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const mappings = [
    { name: "Volkland 3", city: "Запоріжжя", searchId: 16, fopId: "POSREDNIKOVA", terminalId: "POSREDNIKOVA" }, // Adding POSREDNIKOVA terminal match
    { name: "Karamel", city: "Коломия", searchId: 4, fopId: "POSREDNIKOVA" },
    { name: "Karamel", city: "Самбір", searchId: 18, fopId: "POSREDNIKOVA" },
    { name: "Karamel", city: "Шептицький", searchId: 5, fopId: "POSREDNIKOVA" },
];

async function main() {
    console.log("🛠 Updating audit mappings...");

    for (const m of mappings) {
        const loc = await prisma.location.findFirst({
            where: {
                name: m.name,
                city: m.city
            }
        });

        if (loc) {
            console.log(`✅ Updating ${m.name} (${m.city}) with searchId: ${m.searchId}`);
            await prisma.location.update({
                where: { id: loc.id },
                data: {
                    searchId: m.searchId,
                    fopId: m.fopId,
                    // If the user says it's on Posrednikova, we should also probably set fopId to match the Monobank account
                }
            });
        } else {
            console.warn(`⚠️ Location not found: ${m.name} in ${m.city}`);
        }
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
