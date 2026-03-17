import { Bot, Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";

// Mock redis
const mockRedis = {
    hgetall: async () => ({}),
    pipeline: () => ({ hset: () => {}, expire: () => {}, exec: async () => {} }),
    del: async () => {}
};

// Simplified lazySession to test the logic exactly as it is in the real bot
const sessionCache = new Map();
function lazySession() {
    return async (ctx: any, next: any) => {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        const rawKey = chatId ?? userId;
        if (!rawKey) return next();

        const redisKey = `session:${rawKey}`;
        let entry = sessionCache.get(redisKey);

        if (!entry) {
            entry = { 
                data: { step: "idle", candidateData: {}, messagesToDelete: [] }, 
                dirty: false, 
                lastAccessed: Date.now() 
            };
            sessionCache.set(redisKey, entry);
        }

        Object.defineProperty(ctx, 'session', {
            get: () => entry!.data,
            set: (newVal) => {
                entry!.data = newVal;
                entry!.dirty = true;
            }
        });

        console.log("lazySession: before next");
        try {
            await next();
            console.log("lazySession: after next SUCCESS");
        } catch (e) {
            console.log("lazySession: after next CATCH", e);
            throw e;
        } finally {
            console.log("lazySession: after next FINALLY");
        }
    };
}

const bot = new Bot("dummy_token");

// 1. Raw Update Logger
bot.use(async (ctx, next) => {
    console.log("MW 1: Raw Update Logging - BEFORE next()");
    await next();
    console.log("MW 1: Raw Update Logging - AFTER next()");
});

// 2. Sequentialize
bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

// 3. Session
bot.use(lazySession());

// 4. Global Command Breakout
bot.use(async (ctx, next) => {
    console.log("MW 4: Global Command Breakout - BEFORE next()");
    if (ctx.hasCommand("start")) {
        console.log("MW 4: /start detected, resetting session");
        if ((ctx as any).session) {
            (ctx as any).session.step = "idle";
        }
    }
    await next();
    console.log("MW 4: Global Command Breakout - AFTER next()");
});

// 5. Some Handler
bot.command("start", async (ctx) => {
    console.log("HANDLER: /start executed");
});

bot.use(async (ctx, next) => {
    console.log("MW: Catch-all handler reached");
    await next();
});

console.log("Simulating /start update...");
const update = {
    update_id: 123456,
    message: {
        message_id: 1,
        from: { id: 7416029746, is_bot: false, first_name: "Test" },
        chat: { id: 7416029746, type: "private" },
        date: Date.now() / 1000,
        text: "/start",
        entities: [{ offset: 0, length: 6, type: "bot_command" }]
    }
};

bot.init().then(() => {
    bot.handleUpdate(update as any).then(() => {
        console.log("Update processed completely");
    }).catch(e => {
        console.error("Update failed", e);
    });
}).catch(e => {
    console.log("Init mock error", e.message);
    // Ignore invalid token error for init, just inject botInfo
    (bot as any).botInfo = { id: 123, is_bot: true, first_name: "TestBot", username: "test_bot" };
    bot.handleUpdate(update as any).then(() => {
        console.log("Update processed completely");
    }).catch(e => {
        console.error("Update failed", e);
    });
});
