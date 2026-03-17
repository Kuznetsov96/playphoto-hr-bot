import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const mappings = [
    { id: 'cmlqcgvuu0003la3dnw6jo707', name: 'Leolend', city: 'Львів', sheet: 'Leoland' },
    { id: 'cmlqcgvyx000hla3d1cncpb0u', name: 'Dytyache Horyshche', city: 'Хмельницький', sheet: 'DH Khmelnytskyi' },
    { id: 'cmlqcgvv80005la3djk5w7dqc', name: 'Dragon Park', city: 'Львів', sheet: 'DragonP' },
    { id: 'cmlqcgvv20004la3dfz847jdx', name: 'Drive City', city: 'Львів', sheet: 'DriveCity' },
    { id: 'cmlqcgvul0002la3de97zrinm', name: 'Fly Kids', city: 'Київ', sheet: 'FK Київ' },
    { id: 'cmlqcgvvg0006la3dz89dcti6', name: 'Fly Kids', city: 'Львів', sheet: 'FK Львів' },
    { id: 'cmlqcgvya000dla3d7b77q0wv', name: 'Fly Kids', city: 'Рівне', sheet: 'FK Рівне' },
    { id: 'cmlqcgvyf000ela3d66w3ynjd', name: 'Fantasy Town', city: 'Черкаси', sheet: 'FT Черкаси' },
    { id: 'cmlqcgvue0001la3dmy7o74nl', name: 'Smile Park (Darynok)', city: 'Київ', sheet: 'SP Даринок' },
    { id: 'cmlqcgvu40000la3dpbedykxr', name: 'Smile Park', city: 'Київ', sheet: 'SP Київ' },
    { id: 'cmlqcgvvn0007la3dpmt4dgh6', name: 'Smile Park', city: 'Львів', sheet: 'SP Львів' },
    { id: 'cmlqcgvvt0008la3dmgya8w8w', name: 'Volkland', city: 'Запоріжжя', sheet: 'Volkland' },
    { id: 'cmlqcgvwf0009la3dk9grw586', name: 'Volkland 2', city: 'Запоріжжя', sheet: 'Volkland 2' },
    { id: 'cmlqcgvwo000ala3d60mtpkg4', name: 'Volkland 3', city: 'Запоріжжя', sheet: 'Volkland 3' },
    { id: 'cmlqcgvwt000bla3dw4lbfpvd', name: 'Karamel', city: 'Коломия', sheet: 'Карамель К' },
    { id: 'cmlqcgvys000gla3d92ruth2t', name: 'Karamel', city: 'Самбір', sheet: 'Карамель С' },
    { id: 'cmlqcgvy4000cla3d1h4n5gua', name: 'Karamel', city: 'Шептицький', sheet: 'Карамель Ч' },
    { id: 'cmlqcgvym000fla3dlx0v9nrc', name: 'Smile Park', city: 'Харків', sheet: 'SP Харків' }
];

async function main() {
    console.log("🚀 Starting finance mapping fix...");

    for (const m of mappings) {
        console.log(`📡 Updating ${m.name} (${m.id})...`);
        await prisma.location.update({
            where: { id: m.id },
            data: {
                name: m.name,
                city: m.city,
                sheet: m.sheet
            }
        });
    }

    console.log("✅ All mappings updated successfully!");
}

main()
    .catch((e) => {
        console.error("❌ Error during mapping fix:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
