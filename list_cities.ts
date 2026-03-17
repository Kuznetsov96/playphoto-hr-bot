import prisma from "./src/db/core.js";
async function main() {
    const locs = await prisma.location.findMany({ select: { city: true } });
    const cities = [...new Set(locs.map(l => l.city))];
    console.log("Cities in DB:", cities);
    
    const staff = await prisma.staffProfile.findMany({ 
        where: { isActive: true },
        include: { location: true } 
    });
    console.log("Staff with locations:");
    staff.forEach(s => {
        console.log(`- ${s.fullName}: city=${s.location?.city || 'NONE'}`);
    });
}
main();
