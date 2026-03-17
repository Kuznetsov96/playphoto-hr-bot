import { google } from "googleapis";
import path from "path";
import * as dotenv from "dotenv";
dotenv.config();

async function testWrite() {
    console.log("Testing write access with Service Account...");
    const KEY_PATH = path.join(process.cwd(), "google-service-account.json");
    console.log("Key path:", KEY_PATH);
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    
    try {
        const res = await sheets.spreadsheets.values.append({
            spreadsheetId: "1bc6EnZ2YdXuzSl_ik_XEAS06ZaDsKWMwGMqqD1YlOHg",
            range: "Недоступность!A:E",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [["test", "test", null, "test", "test"]] },
        });
        console.log("Success!", res.data);
    } catch (e: any) {
        console.error("Error:", e.message);
        if (e.response && e.response.data && e.response.data.error) {
            console.error("Details:", e.response.data.error);
        }
    }
}
testWrite();
