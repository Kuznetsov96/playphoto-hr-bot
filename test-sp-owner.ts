import prisma from "./src/db/core.js";

async function run() {
    console.log("Locs:");
    const loc = await prisma.location.findFirst({ where: { name: "Smile Park Київ" } });
    console.log(loc);
}
run();
