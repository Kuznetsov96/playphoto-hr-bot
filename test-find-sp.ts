import prisma from "./src/db/core.js";

const run = async () => {
    const loc = await prisma.location.findFirst({ where: { name: "Smile Park Київ" } });
    console.log("SP Kyiv ID:", loc?.id);
    console.log(loc);
}
run();
