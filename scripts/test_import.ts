
try {
    await import("../src/handlers/staff-menu.js");
    console.log("Import success!");
} catch (e) {
    console.error("Import failed:", e);
}
