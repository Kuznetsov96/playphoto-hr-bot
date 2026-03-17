import prisma from "./src/db/core.js";
async function run() {
    console.log("Locs:");
    const locs = await prisma.location.findMany();
    locs.filter(l => Boolean(l.sheet)).forEach(l => console.log(l.name, l.sheet));
}
run();
