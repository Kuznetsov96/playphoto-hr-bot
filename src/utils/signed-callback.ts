import crypto from "crypto";

const CALLBACK_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || process.env.BOT_TOKEN || "dev-callback-secret";
const SIGNATURE_LENGTH = 10;

function sign(code: string, payload: string): string {
    return crypto
        .createHmac("sha256", CALLBACK_SECRET)
        .update(`${code}:${payload}`)
        .digest("hex")
        .slice(0, SIGNATURE_LENGTH);
}

export function buildSignedCallback(code: string, payload: string): string {
    return `cb:${code}:${payload}:${sign(code, payload)}`;
}

export function readSignedCallback(data: string, code: string): string | null {
    const match = data.match(/^cb:([a-z0-9]+):([^:]+):([a-f0-9]+)$/i);
    if (!match) return null;

    const [, actualCode, payload, signature] = match;
    if (!actualCode || !payload || !signature) return null;

    if (actualCode !== code) return null;

    const expected = sign(code, payload);
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

    return payload;
}

export function readCallbackPayload(
    data: string,
    options: {
        code: string;
        legacyPrefix?: string;
    }
): string | null {
    const signedPayload = readSignedCallback(data, options.code);
    if (signedPayload !== null) return signedPayload;

    if (options.legacyPrefix && data.startsWith(options.legacyPrefix)) {
        return data.slice(options.legacyPrefix.length) || null;
    }

    return null;
}
