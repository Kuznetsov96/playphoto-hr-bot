import * as crypto from "crypto";
import * as dotenv from "dotenv";
import logger from "./logger.js";

dotenv.config();

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // Оптимально для GCM
const KEY_LEN = 32;

export class CryptoUtility {
    private isReady: boolean = false;
    private key: Buffer | null = null;

    constructor() {
        const envKey = process.env.ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY;
        if (envKey) {
            this.key = Buffer.from(envKey.padEnd(KEY_LEN, '0').slice(0, KEY_LEN));
            this.isReady = true;
            logger.debug("🔐 CryptoUtility initialized. Application-level encryption enabled.");
        } else {
            logger.warn("⚠️ ENCRYPTION_KEY is missing. Encryption disabled (returning plain text).");
        }
    }

    encrypt(text: string | null | undefined): string | null | undefined {
        if (!text) return text;
        if (!this.isReady || !this.key) return text;

        if (typeof text === 'string' && text.startsWith('gcm:')) {
            return text;
        }

        try {
            const iv = crypto.randomBytes(IV_LENGTH);
            const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
            
            let encrypted: string = cipher.update(text, "utf8", "base64");
            encrypted += cipher.final("base64");
            const tag = cipher.getAuthTag().toString("base64");

            return `gcm:${iv.toString("base64")}:${tag}:${encrypted}`;
        } catch (error) {
            logger.error({ err: error }, "Encryption failed");
            return text; 
        }
    }

    decrypt(text: string | null | undefined): string | null | undefined {
        if (!text) return text;
        if (!this.isReady || !this.key) return text;

        if (typeof text === 'string' && !text.startsWith('gcm:')) {
            return text; 
        }

        try {
            const parts = text.split(":");
            if (parts.length !== 4) return text;

            const ivBase64 = parts[1] as string;
            const tagBase64 = parts[2] as string;
            const encryptedData = parts[3] as string;

            const iv = Buffer.from(ivBase64, "base64");
            const tag = Buffer.from(tagBase64, "base64");

            const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
            decipher.setAuthTag(tag);

            let decrypted: string = decipher.update(encryptedData, "base64", "utf8");
            decrypted += decipher.final("utf8");

            return decrypted;
        } catch (error) {
            logger.error({ err: error }, "Decryption failed. Returning ciphertext.");
            return text; 
        }
    }
}

export const cryptoUtility = new CryptoUtility();
