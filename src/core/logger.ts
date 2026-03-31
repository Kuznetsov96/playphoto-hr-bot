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

const isProd = process.env.NODE_ENV === "production";
const logDir = "/app/logs";

let logger: pino.Logger;

// Check if we are in an environment that should write to a file (Prod or Docker)
const hasLogVolume = fs.existsSync(logDir);

if (isProd || hasLogVolume) {
    // Production style: multi-stream to stdout and file
    const logPath = path.join(logDir, "product.log");
    
    if (!hasLogVolume) {
        try {
            fs.mkdirSync(logDir, { recursive: true });
        } catch (e) {
            console.error("❌ Failed to create log directory:", e);
        }
    }

    const streams = [
        { stream: process.stdout },
        { 
            stream: pino.destination({
                dest: logPath,
                minLength: 0,
                sync: true, // Use sync: true for production stability or if required for critical logs
                append: true,
                mkdir: true
            })
        },
    ];

    logger = pino(pinoOptions, pino.multistream(streams));
} else {
    // Development style: pino-pretty
    pinoOptions.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    };
    logger = pino(pinoOptions);
}

export default logger;
