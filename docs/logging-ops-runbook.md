# Logging Ops Runbook

This file is written for non-technical operators and future LLM sessions.

If something breaks in production, this is the first file to use together with:

- [docs/logging-standard.md](./logging-standard.md)
- [docs/logging-production-audit-2026-04-01.md](./logging-production-audit-2026-04-01.md)
- [docs/logging-centralized-stack.md](./logging-centralized-stack.md)

## What This Project Is Running On

Production runs on **AWS EC2**, and you reach it with **SSM**, not SSH.

| What | Value |
| --- | --- |
| EC2 instance | `i-0285c36d4f870dc30` |
| Instance name tag | `playphoto-staging-app` (the name says staging; this **is** production) |
| Region | `eu-north-1` |
| AWS CLI profile | `playphoto` |
| Deploy directory on the host | `/opt/playphoto-bot` |
| Main bot container | `playphoto-bot-bot-1` |
| App directory inside the container | `/app` |

> **`ssh playphoto` is NOT production.** That alias points at an old Hetzner box
> (`46.224.238.211`) which now runs unrelated services. The bot was there once, so the
> alias and the old paths still look plausible — they are not. On 09.09.2026 an incident
> investigation was sent down that dead end by this very file. Use SSM.

### How to connect

There is no interactive shell without the `session-manager-plugin`, but you do not need
one: `send-command` runs anything and returns the output.

```bash
CMD=$(aws ssm send-command \
  --profile playphoto --region eu-north-1 \
  --instance-ids i-0285c36d4f870dc30 \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["docker ps --format \"{{.Names}}\t{{.Status}}\""]' \
  --query 'Command.CommandId' --output text)

sleep 5

aws ssm get-command-invocation \
  --profile playphoto --region eu-north-1 \
  --command-id "$CMD" --instance-id i-0285c36d4f870dc30 \
  --query 'StandardOutputContent' --output text
```

Check the agent is reachable before blaming the app:

```bash
aws ssm describe-instance-information --profile playphoto --region eu-north-1 \
  --query 'InstanceInformationList[].{ID:InstanceId,Ping:PingStatus}' --output table
```

`PingStatus: Online` means the box is alive even if the bot is not.

Other containers on the same host: `playphoto-web-1`, `playphoto-api-1`,
`playphoto-proxy-1`, `playphoto-bot-redis-1`. For bot incidents inspect
`playphoto-bot-bot-1`.

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

Log files live **inside the bot container**, not on the host:

- `/app/logs/product.log`
- `/app/logs/audit.log`
- `/app/logs/security.log`

They are not mounted to the host, so `find / -name product.log` on the instance finds
nothing. Read them through the container:

```bash
docker exec playphoto-bot-bot-1 sh -lc 'grep -i "topic bootstrap failed" /app/logs/product.log | tail -5'
```

`docker logs playphoto-bot-bot-1` shows the same stream, but **only since the last
container start** — a deploy truncates your window. The files under `/app/logs` survive
restarts within the container's lifetime, so prefer them when investigating anything
older than the current uptime. Neither survives a container **rebuild**: if you need
history across deploys, pull it before redeploying.

Loki (`http://127.0.0.1:3100`) is described in
[docs/logging-centralized-stack.md](./logging-centralized-stack.md); it was not
answering on the production host as of 09.09.2026, so do not rely on it for an
incident without checking first.

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
2. Production access:
   - AWS SSM, instance `i-0285c36d4f870dc30`, region `eu-north-1`, profile `playphoto`
   - **not** `ssh playphoto` — that alias is an unrelated legacy host
3. Deploy directory on the host:
   - `/opt/playphoto-bot`
4. Main container:
   - `playphoto-bot-bot-1` (app at `/app`, logs at `/app/logs`)
5. Primary docs:
   - `docs/logging-standard.md`
   - `docs/logging-production-audit-2026-04-01.md`
   - `docs/logging-centralized-stack.md`
   - `docs/logging-ops-runbook.md`
6. Goal:
   - reconstruct the incident from logs without reading code first

Recommended prompt for the next LLM:

`Inspect production logging for the PlayPhoto HR bot. Production is AWS EC2 i-0285c36d4f870dc30 in eu-north-1, reachable with "aws ssm send-command --profile playphoto"; the bot container is playphoto-bot-bot-1 and its logs are at /app/logs inside it. Do NOT use "ssh playphoto" — that host no longer runs the bot. Start from docs/logging-ops-runbook.md and docs/logging-standard.md, read the log files first, and read code only if logs are insufficient.`

## Safe First Commands

These are the first commands an engineer or LLM should run during an incident. Each one
is a `send-command` — set `CMD` from the snippet in *How to connect* above, then read the
output with `get-command-invocation`.

Commands to pass in `--parameters`:

```bash
# is the box even reachable
aws ssm describe-instance-information --profile playphoto --region eu-north-1 \
  --query 'InstanceInformationList[].{ID:InstanceId,Ping:PingStatus}' --output table

# what is running
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# recent errors (level 50 = error in pino)
docker exec playphoto-bot-bot-1 sh -lc 'grep "\"level\":50" /app/logs/product.log | tail -20'

# privileged actions
docker exec playphoto-bot-bot-1 sh -lc 'tail -50 /app/logs/audit.log'

# when did the container last restart (defines the docker-logs window)
docker inspect -f "{{.State.StartedAt}}" playphoto-bot-bot-1
```

If the problem is about a specific candidate or user, grep the log files by Telegram ID
or event name — the logs are newline-delimited JSON, so plain `grep` is enough:

```bash
docker exec playphoto-bot-bot-1 sh -lc 'grep "\"telegram_id\":\"944643678\"" /app/logs/product.log | tail -20'
docker exec playphoto-bot-bot-1 sh -lc 'grep "candidate.screening.completed" /app/logs/product.log | tail -20'
docker exec playphoto-bot-bot-1 sh -lc 'grep "security.channel_access.revoked" /app/logs/security.log | tail -20'
```

Timestamps are epoch milliseconds in the `time` field. To convert:
`python3 -c "import datetime,sys; print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])/1000))" 1788967926117`

Kyiv time is UTC+3, so a 15:32 UTC log line is an 18:32 event for the operator who
reported it.

## Known Current Gaps

These are already known and do not need rediscovery every time:

1. Some callback payload values are still noisier than ideal.
2. `docker logs` only covers the time since the last container start, and a deploy resets
   it. Files under `/app/logs` go back further, but neither survives a container rebuild.
3. Loki was not answering on the production host as of 09.09.2026 — check before relying
   on it, and fall back to the log files.

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
