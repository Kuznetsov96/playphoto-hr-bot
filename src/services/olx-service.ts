import logger from "../core/logger.js";

/**
 * FEATURE DISABLED: OLX integration is now handled manually.
 */
export class OLXService {
    async sendMessage(externalId: string, text: string): Promise<boolean> {
        return false;
    }

    async getThreads(): Promise<any[]> {
        return [];
    }

    async getMessages(threadId: string): Promise<any[]> {
        return [];
    }
}

export const olxService = new OLXService();
