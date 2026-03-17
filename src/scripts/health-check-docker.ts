#!/usr/bin/env node
/**
 * Health check script to verify bot can access Google Sheets API
 * Run this inside Docker container to diagnose connectivity issues
 */

import { google } from "googleapis";
import path from "path";
import fs from "fs";
import { SPREADSHEET_ID_SCHEDULE, SPREADSHEET_ID_TEAM, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } from "../config.js";

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

async function main() {
    console.log("\n🏥 Running Health Check for Google Sheets Integration\n");
    console.log("=" .repeat(60));

    let passed = 0;
    let failed = 0;

    // 1. Check environment variables
    console.log("\n📋 Checking environment variables...");
    const checks = [
        { name: "GOOGLE_CLIENT_ID", value: GOOGLE_CLIENT_ID },
        { name: "GOOGLE_CLIENT_SECRET", value: GOOGLE_CLIENT_SECRET?.substring(0, 5) + "...", envValue: GOOGLE_CLIENT_SECRET },
        { name: "GOOGLE_REFRESH_TOKEN", value: GOOGLE_REFRESH_TOKEN?.substring(0, 5) + "...", envValue: GOOGLE_REFRESH_TOKEN },
        { name: "SPREADSHEET_ID_TEAM", value: SPREADSHEET_ID_TEAM },
        { name: "SPREADSHEET_ID_SCHEDULE", value: SPREADSHEET_ID_SCHEDULE }
    ];

    for (const check of checks) {
        if (check.envValue) {
            console.log(`   ${GREEN}✓${RESET} ${check.name}: ${check.value}`);
            passed++;
        } else {
            console.log(`   ${RED}✗${RESET} ${check.name}: MISSING`);
            failed++;
        }
    }

    // 2. Check if google-service-account.json exists
    console.log("\n📁 Checking google-service-account.json...");
    const KEY_PATH = path.join(process.cwd(), 'google-service-account.json');
    if (fs.existsSync(KEY_PATH)) {
        console.log(`   ${GREEN}✓${RESET} File exists at: ${KEY_PATH}`);
        passed++;
        try {
            const keyData = JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'));
            console.log(`   ${GREEN}✓${RESET} Valid JSON with service account: ${keyData.client_email}`);
            passed++;
        } catch (e) {
            console.log(`   ${RED}✗${RESET} Invalid JSON format`);
            failed++;
        }
    } else {
        console.log(`   ${YELLOW}⚠${RESET} File not found (this is OK if using GOOGLE_REFRESH_TOKEN)`);
    }

    // 3. Test authentication
    console.log("\n🔑 Testing authentication...");
    try {
        let auth: any;

        if (GOOGLE_REFRESH_TOKEN) {
            auth = new google.auth.OAuth2(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET
            );
            auth.setCredentials({
                refresh_token: GOOGLE_REFRESH_TOKEN,
                scope: 'https://www.googleapis.com/auth/spreadsheets'
            });
            console.log(`   ${GREEN}✓${RESET} Using OAuth2 with refresh token`);
        } else {
            auth = new google.auth.GoogleAuth({
                keyFile: KEY_PATH,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            console.log(`   ${GREEN}✓${RESET} Using service account from file`);
        }
        passed++;

        // 4. Test Sheets API access
        console.log("\n📊 Testing Google Sheets API access...");
        const sheets = google.sheets({ version: 'v4', auth });

        // Test Team Spreadsheet
        try {
            const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID_TEAM });
            const sheetTitle = res.data.properties?.title;
            console.log(`   ${GREEN}✓${RESET} Team Spreadsheet accessible: "${sheetTitle}"`);
            passed++;
        } catch (e: any) {
            console.log(`   ${RED}✗${RESET} Team Spreadsheet ERROR: ${e.message}`);
            failed++;
        }

        // Test Schedule Spreadsheet
        try {
            const res = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID_SCHEDULE });
            const sheetTitle = res.data.properties?.title;
            console.log(`   ${GREEN}✓${RESET} Schedule Spreadsheet accessible: "${sheetTitle}"`);
            passed++;
        } catch (e: any) {
            console.log(`   ${RED}✗${RESET} Schedule Spreadsheet ERROR: ${e.message}`);
            failed++;
        }

        // Test fetching data from Team sheet
        try {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID_TEAM,
                range: "'В роботі'!A1:S10"
            });
            const rowCount = res.data.values?.length || 0;
            console.log(`   ${GREEN}✓${RESET} Can fetch data from Team sheet (${rowCount} rows found)`);
            passed++;
        } catch (e: any) {
            console.log(`   ${RED}✗${RESET} Error fetching Team sheet data: ${e.message}`);
            failed++;
        }

        // Test fetching data from Schedule sheet
        try {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID_SCHEDULE,
                range: "'Актуальний розклад'!A1:C10"
            });
            const rowCount = res.data.values?.length || 0;
            console.log(`   ${GREEN}✓${RESET} Can fetch data from Schedule sheet (${rowCount} rows found)`);
            passed++;
        } catch (e: any) {
            console.log(`   ${RED}✗${RESET} Error fetching Schedule sheet data: ${e.message}`);
            failed++;
        }

    } catch (e: any) {
        console.log(`   ${RED}✗${RESET} Authentication failed: ${e.message}`);
        failed++;
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("\n📊 HEALTH CHECK SUMMARY");
    console.log(`   ${GREEN}Passed: ${passed}${RESET}`);
    console.log(`   ${RED}Failed: ${failed}${RESET}`);

    if (failed === 0) {
        console.log(`\n${GREEN}✓ All checks passed! Google Sheets integration is working.${RESET}\n`);
        process.exit(0);
    } else {
        console.log(`\n${RED}✗ Some checks failed. Please debug the issues above.${RESET}\n`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(`${RED}Fatal error:${RESET}`, e);
    process.exit(1);
});
