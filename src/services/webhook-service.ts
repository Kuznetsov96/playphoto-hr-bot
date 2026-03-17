import http from "http";
import url from "url";
import { Api } from "grammy";
import logger from "../core/logger.js";

export class WebhookService {
    /**
     * FEATURE SEMI-DISABLED: Only Health Check is active.
     */
    listen(api: Api) {
        const port = Number(process.env.HEALTH_PORT) || 8080;

        http.createServer(async (req, res) => {
            const parsedUrl = url.parse(req.url || "", true);

            // 1. Health Check (Required for Docker/Deployment)
            if (parsedUrl.pathname === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'ok' }));
            }

            // All other endpoints disabled
            res.writeHead(404);
            res.end();
        }).listen(port, '0.0.0.0', () => {
            logger.info(`🌐 Webhook server listening on port ${port} (Health Check Only)`);
        });
    }
}

export const webhookService = new WebhookService();
