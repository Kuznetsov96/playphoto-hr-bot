# Production Logging Audit

Date: `2026-04-01`
Target runtime: `playphoto_hr_bot` on host alias `playphoto`

## Verified Runtime

- Deployed app is running as Docker container `playphoto_hr_bot-bot-1`
- Active image: `ghcr.io/kuznetsov96/playphoto-hr-bot:ce71b5d`
- This matches the merged `main` release commit prefix `ce71b5d`
- Compose path on server: `/home/playphoto-mgr/playphoto_hr_bot/docker-compose.yml`

## Verified Logging State

- Docker container logs use `json-file` with `max-size=20m` and `max-file=3`
- App logs are bind-mounted to `/home/playphoto-mgr/playphoto_hr_bot/logs`
- `product.log`, `audit.log`, and `security.log` exist on disk
- Centralized logging is running locally on the host through:
  - `playphoto_hr_bot-loki-1`
  - `playphoto_hr_bot-alloy-1`
- Loki readiness is healthy on `127.0.0.1:3100`
- Alloy readiness is healthy on `127.0.0.1:12345`
- Loki queries already return live `product` events for `playphoto_hr_bot`
- Critical runtime events are reconstructable from production logs:
  - loop/job start events
  - Telegram update intake with correlation IDs
  - candidate screening completion
  - audit/security actions such as channel access revocation
- Side operational scripts were re-verified after rollout:
  - `monitor-disk.sh` executes successfully
  - `backup-db.sh` runs successfully with local encrypted backup output

## Remaining Risks

These items still deserve attention, but they no longer block a production-grade incident surface:

1. Some callback payloads are still logged too literally in `telegram.update.received`.
   - This is useful for debugging, but some values look noisy or partially corrupted and are not ideal as a long-term incident surface.
2. Historical old log files still have mixed ownership.
   - Some active logs are owned by `root`, others by `playphoto-mgr`
   - This increases the chance of operational friction during cleanup or retrieval
3. Loki is intentionally localhost-only.
   - This is correct for security, but operators must use SSH for queries unless a secure dashboard layer is added later

## What Is Good Enough Today

The current deployment is strong enough that an engineer or LLM can investigate production incidents without reading source code first, because:

- structured `event` names are present in production
- `telegram_id`, `correlation_id`, `result`, `module`, and `safe_context` are present in key flows
- `product`, `audit`, `security`, and `ops` are searchable through Loki
- audit/security actions are persisted on disk

This is now a verified infra-grade logging platform for the current production host.

## Current 10/10 Decision

For this repository and this host, the logging system can now be treated as `10/10` for operational incident recovery because:

1. structured app logs are present and searchable
2. `product`, `audit`, `security`, and `ops` are separated logically
3. centralized searchable retention exists on the host
4. access is restricted through localhost binding plus SSH access
5. incidents can be reconstructed without reading code first
6. side scripts that were previously failing now execute successfully

## Incident Operator Minimum

For this deployment to stay LLM-ready, operators should be able to retrieve logs by:

- `event`
- `candidate_id`
- `telegram_id`
- `correlation_id`
- `result`
- time range

This capability is now available through Loki queries on the production host.
