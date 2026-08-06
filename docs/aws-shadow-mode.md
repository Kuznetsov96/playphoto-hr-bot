# AWS shadow mode

Shadow mode verifies that the bot image can reach the restored PostgreSQL database without starting any production behavior.

It intentionally does not:

- start Telegram polling or modify the Telegram webhook;
- import or connect to Redis and BullMQ;
- start background workers, reminders, reports, or external integrations;
- run Prisma migrations;
- write application data.

## Required environment

```text
BOT_STARTUP_MODE=shadow
DATABASE_URL=postgresql://<read-only-user>:<password>@<host>:5432/playphoto_bot?sslmode=require
SHADOW_EXPECTED_DATABASE=playphoto_bot
SHADOW_HEALTH_INTERVAL_MS=60000
```

Start the image with an explicit command override:

```bash
npm run start:shadow
```

The process refuses to become ready unless:

- `BOT_STARTUP_MODE` is exactly `shadow`;
- the connected database has the expected name;
- PostgreSQL reports `transaction_read_only=on` for the session.

The `bot.shadow.ready` event confirms that Telegram, Redis, workers, and migrations were not started. A database health-check failure terminates the process with a non-zero exit code.

