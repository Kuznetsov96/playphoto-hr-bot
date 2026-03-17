import pino from "pino";
import type { LoggerOptions } from "pino";

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

if (process.env.NODE_ENV !== "production") {
    pinoOptions.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true
        }
    };
}

const logger = pino(pinoOptions);

export default logger;
