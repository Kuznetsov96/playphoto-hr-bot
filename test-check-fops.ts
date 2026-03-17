import prisma from "./src/db/core.js";

async function run() {
    const locs = [
        "Fly Kids (Патона)",
        "Smile Park Lviv",
        "Каремель Коломия",
        "Каремель Шептицкий",
        "Volkland 3",
        "Karamel Sambir"
    ];

    const result = await prisma.location.findMany({
        where: { OR: locs.map(name => ({ name: { contains: name } })) }
    });

    console.log("Database mappings:");
    result.forEach(r => {
        console.log(`- ${r.name}: FOP=${r.fopId}, Acquiring=${r.hasAcquiring}`);
    });
}
run();
