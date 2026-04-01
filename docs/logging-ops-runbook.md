# Logging Ops Runbook

This file is written for non-technical operators and future LLM sessions.

If something breaks in production, this is the first file to use together with:

- [docs/logging-standard.md](./logging-standard.md)
- [docs/logging-production-audit-2026-04-01.md](./logging-production-audit-2026-04-01.md)

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
   - today these events are stored inside `audit.log`

Current file locations on the server:

- `/home/playphoto-mgr/playphoto_hr_bot/logs/product.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/audit.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/monitor.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/backup.log`

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
   - `docs/logging-ops-runbook.md`
6. Goal:
   - reconstruct the incident from structured logs without reading code first

Recommended prompt for the next LLM:

`Inspect production logging for playphoto_hr_bot on ssh playphoto. Start from docs/logging-standard.md, docs/logging-production-audit-2026-04-01.md, and docs/logging-ops-runbook.md. Use product and audit logs first, then code only if logs are insufficient.`

## Safe First Commands

These are the first commands an engineer or LLM should run during an incident:

```bash
ssh playphoto 'docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"'
ssh playphoto 'docker logs --tail 100 playphoto_hr_bot-bot-1'
ssh playphoto 'tail -n 100 /home/playphoto-mgr/playphoto_hr_bot/logs/product.log'
ssh playphoto 'tail -n 100 /home/playphoto-mgr/playphoto_hr_bot/logs/audit.log'
```

If the problem is about a specific candidate or user, search by Telegram ID or event:

```bash
ssh playphoto 'grep -n "944643678" /home/playphoto-mgr/playphoto_hr_bot/logs/product.log | tail -n 20'
ssh playphoto 'grep -n "candidate.screening.completed" /home/playphoto-mgr/playphoto_hr_bot/logs/product.log | tail -n 20'
ssh playphoto 'grep -n "security.channel_access.revoked" /home/playphoto-mgr/playphoto_hr_bot/logs/audit.log | tail -n 20'
```

## Known Current Gaps

These are already known and do not need rediscovery every time:

1. There is no verified centralized logging sink yet.
2. `security` is not separated into its own persisted stream yet.
3. Some startup and worker logs are still noisier than ideal.
4. `monitor.log` currently contains repeated permission failures.
5. `backup.log` currently contains backup/upload issues.

## What “10/10” Means Here

The system is truly `10/10` only when all of these are true:

1. structured app logs are present
2. `product`, `audit`, and `security` are clearly separated
3. centralized searchable retention exists
4. access to sensitive logs is restricted
5. an incident can be reconstructed without reading code first
6. side jobs like monitor and backup are also healthy

## Decision Rule For Non-Technical Operators

If production is broken and you do not know what to do:

1. Open this file and the production audit file.
2. Ask the LLM to inspect `product.log` and `audit.log` first.
3. Ask it to explain the issue in plain language.
4. Only after that ask for a fix or deployment action.

This order reduces the risk of guessing and helps future LLMs stay grounded in real production evidence.
