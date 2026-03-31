import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

async function upload() {
    const filePath = process.argv[2];
    if (!filePath) throw new Error('No file path provided');

    const auth = new google.auth.GoogleAuth({
        keyFile: '/app/google-service-account.json',
        scopes: [
            'https://www.googleapis.com/auth/drive.file', 
            'https://www.googleapis.com/auth/drive'
        ],
    });

    const drive = google.drive({ version: 'v3', auth });
    const folderId = '1B9uxeL_fPq5QN2KL-Bz1clkR6C5ex497';
    // YOUR EMAIL - crucial for quota!
    const ownerEmail = 'mitsunia2019@gmail.com'; 

    const fileName = path.basename(filePath);
    console.log(`🚀 Starting upload of ${fileName} to folder ${folderId}...`);
    
    const media = {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(filePath),
    };

    // 1. Upload the file
    const file = await drive.files.create({
        requestBody: { 
            name: fileName, 
            parents: [folderId] 
        },
        media: media,
        fields: 'id',
    });

    console.log(`✅ Uploaded to ID: ${file.data.id}. Now transferring ownership...`);

    // 2. Transfer ownership to YOU (so quota is used from YOUR account)
    try {
        await drive.permissions.create({
            fileId: file.data.id,
            transferOwnership: true,
            requestBody: {
                role: 'owner',
                type: 'user',
                emailAddress: ownerEmail,
            },
        });
        console.log(`👑 Ownership transferred successfully to ${ownerEmail}`);
    } catch (permErr) {
        console.warn(`⚠️ Ownership transfer failed (but file might be uploaded): ${permErr.message}`);
    }

    console.log(`✅ Success! File ID: ${file.data.id}`);
}

upload().catch(err => {
    console.error(`❌ Final Error: ${err.message}`);
    process.exit(1);
});
