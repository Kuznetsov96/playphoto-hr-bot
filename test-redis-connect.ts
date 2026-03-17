import { Redis } from "ioredis";
const redis = new Redis({ lazyConnect: true });
redis.connect().catch(() => {}); // simulate BullMQ triggering connect
redis.connect().then(() => console.log("Success")).catch(e => console.error("Error:", e.message));
