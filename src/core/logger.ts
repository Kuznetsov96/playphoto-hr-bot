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
            "*.fullName",
            "*.email",
            "*.firstName",
            "*.lastName",
            "*.username",
            "payload.iban",
            "payload.passportNumber",
            "payload.ipn",
            "payload.bankCard",
            "ctx.message.text",
            "ctx.message.caption",
            "ctx.update.message.text",
            "ctx.update.message.caption",
            "ctx.message.from.first_name",
            "ctx.message.from.last_name",
            "ctx.message.from.username",
            "ctx.from.first_name",
            "ctx.from.last_name",
            "ctx.from.username",
            "user.firstName",
            "user.lastName",
            "user.username",
            "candidate.fullName",
            "staffProfile.fullName"
        ],
        censor: "[PROTECTED]",
    }
};

const isProd = process.env.NODE_ENV === "production";
let logger: pino.Logger;

if (isProd) {
    // In production, we write to both stdout and a persistent file
    const logDir = "/app/logs";
    const logPath = path.join(logDir, "product.log");

    if (!fs.existsSync(logDir)) {
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
                sync: true, // Ensure logs are written immediately to avoid loss
                append: true
            })
        },
    ];

    logger = pino(pinoOptions, pino.multistream(streams));
} else {
    // In development, use pino-pretty for better readability
    pinoOptions.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    };
    logger = pino(pinoOptions);
}

export default logger;
