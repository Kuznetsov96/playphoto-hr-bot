import { techCashService } from "../services/finance/tech-cash.js";
import { locationRepository } from "../repositories/location-repository.js";
import { google } from "googleapis";
import { SPREADSHEET_ID_TECH_CASH } from "../config.js";

async function testTechCash() {
    const dateStr = "16.02.2026";
    console.log(`\n🔍 Testing TechCash for date: ${dateStr}\n`);

    // 1. Check DB locations with sheets
    const dbLocations = await locationRepository.findActiveWithSheet();
    console.log(`📍 DB locations with sheet: ${dbLocations.length}`);
    dbLocations.forEach((loc, i) => {
        console.log(`   ${i + 1}. ${loc.name} (${loc.city}) → sheet: "${(loc as any).sheet}"`);
    });

    // 2. Try batchGet
    console.log(`\n📊 Spreadsheet ID: ${SPREADSHEET_ID_TECH_CASH}`);
    const ranges = dbLocations.map(loc => `${(loc as any).sheet}!A:Z`);
    console.log(`\n📋 Requesting ${ranges.length} ranges...`);

    let auth: any;
    if (process.env.GOOGLE_REFRESH_TOKEN) {
        auth = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );
        auth.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
            scope: 'https://www.googleapis.com/auth/spreadsheets'
        });
    } else {
        const path = await import("path");
        auth = new google.auth.GoogleAuth({
            keyFile: path.join(process.cwd(), 'google-service-account.json'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    }
    const sheets = google.sheets({ version: 'v4', auth });

    // Test batchGet
    try {
        const res = await sheets.spreadsheets.values.batchGet({
            spreadsheetId: SPREADSHEET_ID_TECH_CASH,
            ranges,
            valueRenderOption: 'FORMATTED_VALUE'
        });
        console.log(`✅ batchGet succeeded! Got ${res.data.valueRanges?.length} ranges.`);
    } catch (e: any) {
        console.log(`❌ batchGet FAILED: ${e.message}`);
        console.log(`\n🔄 Testing individual sheets...`);
        for (const loc of dbLocations) {
            const range = `${(loc as any).sheet}!A:Z`;
            try {
                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID_TECH_CASH,
                    range,
                    valueRenderOption: 'FORMATTED_VALUE'
                });
                const rows = res.data.values || [];
                console.log(`   ✅ ${loc.name} (${(loc as any).sheet}): ${rows.length} rows`);
            } catch (e2: any) {
                console.log(`   ❌ ${loc.name} (${(loc as any).sheet}): ${e2.message}`);
            }
        }
    }

    // 3. Test full getIncomeForDate
    console.log(`\n📊 Running techCashService.getIncomeForDate("${dateStr}")...`);
    const incomes = await techCashService.getIncomeForDate(dateStr);
    console.log(`\n📊 Results: ${incomes.length} locations with data\n`);

    if (incomes.length === 0) {
        console.log("⚠️  No incomes found! Checking date formats in sheets...\n");
        // Check what dates look like in each sheet
        for (const loc of dbLocations) {
            try {
                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID_TECH_CASH,
                    range: `${(loc as any).sheet}!A:A`,
                    valueRenderOption: 'FORMATTED_VALUE'
                });
                const rows = res.data.values || [];
                const lastDates = rows.slice(-5).map((r: any[]) => String(r[0] || "").trim()).filter(Boolean);
                console.log(`   ${loc.name}: last dates = ${JSON.stringify(lastDates)}`);
            } catch (e: any) {
                console.log(`   ${loc.name}: ❌ ${e.message}`);
            }
        }
    } else {
        incomes.forEach(inc => {
            console.log(`   ✅ ${inc.locationName} (${inc.city}): cash=${inc.totalCash}, term=${inc.totalTerminal}, salary=${inc.totalSalary}, comment="${inc.comment || ''}"`);
        });
        const missing = dbLocations.filter(loc => !incomes.find(i => i.locationId === loc.id));
        if (missing.length > 0) {
            console.log(`\n⚠️  Missing data for ${missing.length} locations:`);
            missing.forEach(loc => console.log(`   • ${loc.name} (${loc.city}) → sheet: "${(loc as any).sheet}"`));
        }
    }

    process.exit(0);
}

testTechCash().catch(e => { console.error(e); process.exit(1); });
