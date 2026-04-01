# Logging Ops Runbook

This file is written for non-technical operators and future LLM sessions.

If something breaks in production, this is the first file to use together with:

- [docs/logging-standard.md](./logging-standard.md)
- [docs/logging-production-audit-2026-04-01.md](./logging-production-audit-2026-04-01.md)
- [docs/logging-centralized-stack.md](./logging-centralized-stack.md)

## What This Project Is Running On

Production host alias:

- `playphoto`

Production app path on the server:

- `/home/playphoto-mgr/playphoto_hr_bot`

Main bot container name:

- `playphoto_hr_bot-bot-1`

Important note:

- This bot is deployed with Docker.
- The server also has other old services.
- For incident work, always inspect `playphoto_hr_bot`, not the legacy Python bot.

## What Logs Exist

There are three logical streams:

1. `product`
   - day-to-day operational events
   - candidate flow, workers, background jobs, Telegram updates
2. `audit`
   - privileged actions and important state changes
   - admin/support actions that must be reconstructable later
3. `security`
   - security-sensitive actions such as access revocation
   - these events are also persisted into `security.log`
4. `ops`
   - monitor and backup execution logs

Current file locations on the server:

- `/home/playphoto-mgr/playphoto_hr_bot/logs/product.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/audit.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/security.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/monitor.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/backup.log`

Centralized query endpoint on the server:

- Loki: `http://127.0.0.1:3100`

## What An Incident Investigator Should Look For

The main search keys are:

- `event`
- `candidate_id`
- `telegram_id`
- `correlation_id`
- `result`
- time window

Good production events look like:

- `telegram.update.received`
- `candidate.screening.completed`
- `staff.shift_reminder_loop.started`
- `logs.product.rotation_loop.started`
- `security.channel_access.revoked`

If an event exists, it is usually more important than plain text `msg`.

## What To Tell The Next LLM

If you need help from another LLM, give it this exact context:

1. Repository path:
   - `/Users/vitaliikuznetsov/PlayPhoto/playphoto_hr_bot`
2. Production host:
   - `ssh playphoto`
3. Production app path:
   - `/home/playphoto-mgr/playphoto_hr_bot`
4. Main container:
   - `playphoto_hr_bot-bot-1`
5. Primary docs:
   - `docs/logging-standard.md`
   - `docs/logging-production-audit-2026-04-01.md`
   - `docs/logging-centralized-stack.md`
   - `docs/logging-ops-runbook.md`
6. Goal:
   - reconstruct the incident from centralized logs without reading code first

Recommended prompt for the next LLM:

`Inspect production logging for playphoto_hr_bot on ssh playphoto. Start from docs/logging-standard.md, docs/logging-production-audit-2026-04-01.md, docs/logging-centralized-stack.md, and docs/logging-ops-runbook.md. Query Loki first, use on-host file tails second, and read code only if logs are insufficient.`

## Safe First Commands

These are the first commands an engineer or LLM should run during an incident:

```bash
ssh playphoto 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"'
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="product"}'\'' --data-urlencode '\''limit=20'\'''
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="audit"}'\'' --data-urlencode '\''limit=20'\'''
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="security"}'\'' --data-urlencode '\''limit=20'\'''
```

If the problem is about a specific candidate or user, search by Telegram ID or event:

```bash
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="product"} | json | telegram_id="944643678"'\'' --data-urlencode '\''limit=20'\'''
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="product"} | json | event="candidate.screening.completed"'\'' --data-urlencode '\''limit=20'\'''
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="security"} | json | event="security.channel_access.revoked"'\'' --data-urlencode '\''limit=20'\'''
```

## Known Current Gaps

These are already known and do not need rediscovery every time:

1. Some callback payload values are still noisier than ideal.
2. Historical log file ownership on disk is mixed between `root` and `playphoto-mgr`.
3. Loki is localhost-only by design, so access requires SSH.

## What “10/10” Means Here

The system is truly `10/10` only when all of these are true:

1. structured app logs are present
2. `product`, `audit`, `security`, and `ops` are clearly separated
3. centralized searchable retention exists
4. access to sensitive logs is restricted
5. an incident can be reconstructed without reading code first
6. side jobs like monitor and backup are also healthy

## Decision Rule For Non-Technical Operators

If production is broken and you do not know what to do:

1. Open this file and the production audit file.
2. Ask the LLM to query Loki first.
3. Ask it to explain the issue in plain language.
4. Only after that ask for a fix or deployment action.

This order reduces the risk of guessing and helps future LLMs stay grounded in real production evidence.
