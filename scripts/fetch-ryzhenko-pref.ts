
import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
    const auth = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = "1bc6EnZ2YdXuzSl_ik_XEAS06ZaDsKWMwGMqqD1YlOHg";

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Недоступность!A:E',
        });

        const rows = response.data.values || [];
        console.log(`Total rows: ${rows.length}`);

        const ryzhenkoRows = rows.filter(row => row[1] && row[1].includes("Риженко"));
        
        if (ryzhenkoRows.length === 0) {
            console.log("No rows found for Риженко");
        } else {
            console.log("Found rows for Риженко:");
            console.log(JSON.stringify(ryzhenkoRows, null, 2));
        }
    } catch (error: any) {
        console.error("Error:", error.message);
    }
}

main();
