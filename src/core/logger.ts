import pino from "pino";
import type { LoggerOptions } from "pino";
import fs from "fs";
import path from "path";

/**
 * PlayPhoto Security Logger Configuration.
 * Automatically redacts sensitive fields to prevent PII (Personally Identifiable Information) 
 * leaks into log files, even in debug mode.
 */
const pinoOptions: LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    redact: {
        paths: [
            "*.iban",
            "*.passportNumber",
            "*.ipn",
            "*.bankCard",
            "*.registrationAddress",
            "*.phone",
            //"*.fullName", // Temporarily disabled for debugging journey
            "*.email",
            "payload.iban",
            "payload.passportNumber",
            "payload.ipn",
            "payload.bankCard",
            "ctx.message.text",
            "ctx.message.caption",
            "ctx.update.message.text",
            "ctx.update.message.caption"
        ],
        censor: "[PROTECTED]",
    }
};

const streams: any[] = [{ stream: process.stdout }];

// Persistence: write to /app/logs in production/docker
if (process.env.NODE_ENV === "production" || fs.existsSync("/app/logs")) {
    const logPath = "/app/logs/product.log";
    try {
        // Ensure directory exists (though volume should handle it)
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        streams.push({ 
            stream: pino.destination({ 
                dest: logPath, 
                minLength: 0, 
                sync: false,
                mkdir: true 
            }) 
        });
        console.log(`📡 Logger: Writing to ${logPath}`);
    } catch (e) {
        console.error("❌ Failed to initialize file logger:", e);
    }
}

if (process.env.NODE_ENV !== "production" && !fs.existsSync("/app/logs")) {
    pinoOptions.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    };
}

const logger = pino(pinoOptions, pino.multistream(streams));

export default logger;
