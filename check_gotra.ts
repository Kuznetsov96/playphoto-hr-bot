import prisma from "./src/db/core.js";

async function run() {
    const candidate = await prisma.candidate.findFirst({
        where: { fullName: { contains: "Готра" } },
        include: { user: true, location: true }
    });
    console.log(JSON.stringify(candidate, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        return value;
    }, 2));
    process.exit(0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
