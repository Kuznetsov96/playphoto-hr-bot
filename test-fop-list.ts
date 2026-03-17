import prisma from "./src/db/core.js";

async function run() {
    const locs = await prisma.location.findMany({ where: { isHidden: false }, orderBy: { name: 'asc' } });
    for (const l of locs) {
        let fopTerm = l.fopId || "KUZNETSOV";
        if (l.name === 'Smile Park Київ') fopTerm = "GUPALOVA"; // our override
        console.log(`- **${l.name}** (${l.city}): Термінал -> ФОП ${fopTerm} | Готівка -> ФОП KUZNETSOV`);
    }
}
run();
