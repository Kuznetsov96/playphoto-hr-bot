import { redis } from "./src/core/redis.js";
import { Queue } from "bullmq";

console.log("Initializing Queue...");
const myQueue = new Queue("test-queue", { connection: redis });

async function run() {
    console.log("Delaying slightly to let Queue do background things...");
    await new Promise(r => setTimeout(r, 100));

    console.log("Calling redis.connect()...");
    try {
        await redis.connect();
        console.log("Success!");
    } catch(e) {
        console.log("FAIL:", e.message);
    }
    process.exit(0);
}
run();
