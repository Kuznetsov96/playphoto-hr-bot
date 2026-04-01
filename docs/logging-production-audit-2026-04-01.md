# Production Logging Audit

Date: `2026-04-01`
Target runtime: `playphoto_hr_bot` on host alias `playphoto`

## Verified Runtime

- Deployed app is running as Docker container `playphoto_hr_bot-bot-1`
- Active image: `ghcr.io/kuznetsov96/playphoto-hr-bot:0f033e6`
- This matches the merged `main` release commit prefix `0f033e6`
- Compose path on server: `/home/playphoto-mgr/playphoto_hr_bot/docker-compose.yml`

## Verified Logging State

- Docker container logs use `json-file` with `max-size=20m` and `max-file=3`
- App logs are bind-mounted to `/home/playphoto-mgr/playphoto_hr_bot/logs`
- `product.log` and `audit.log` exist and contain structured JSON events
- Security-relevant events are present in `audit.log` with `security=true`
- Critical runtime events are reconstructable from production logs:
  - loop/job start events
  - Telegram update intake with correlation IDs
  - candidate screening completion
  - audit/security actions such as channel access revocation

## Verified Gaps

These items prevent a fully proven infra-side `10/10`:

1. No centralized log shipper was found on the host.
   - No `vector`, `promtail`, `filebeat`, `fluent-bit`, `grafana-agent`, or `otel` service was detected.
2. No separate persisted `security.log` stream was found.
   - Security events currently appear inside `audit.log`.
3. Legacy startup and worker noise still appears in live `stdout` / `product.log`.
   - Examples include startup emoji logs and invite-reminder worker prose.
4. Some callback payloads are still logged too literally in `telegram.update.received`.
   - This is useful for debugging, but some values look noisy or partially corrupted and are not ideal as a long-term incident surface.
5. Side operational logs show existing failures:
   - `monitor.log`: repeated `Permission denied` for `scripts/monitor-disk.sh`
   - `backup.log`: Google Drive upload failures and missing config errors
6. File ownership is mixed.
   - Some active logs are owned by `root`, others by `playphoto-mgr`
   - This increases the chance of operational friction during cleanup or retrieval

## What Is Good Enough Today

The current deployment is strong enough that an engineer or LLM can investigate many app-level incidents without reading source code, because:

- structured `event` names are present in production
- `telegram_id`, `correlation_id`, `result`, `module`, and `safe_context` are present in key flows
- audit/security actions are persisted on disk

This is a strong repo-side and runtime-app result, but not yet a fully verified infra-grade logging platform.

## Required To Reach A Proven 10/10

1. Add a centralized sink for container stdout and file streams.
   - Example targets: Datadog, Loki, ELK, Cloud Logging
2. Route `product`, `audit`, and `security` as separate searchable streams or indexes.
3. Keep explicit retention and access policy by stream.
   - `product`: operational retention
   - `audit`: longer investigation retention
   - `security`: longest retention with restricted access
4. Sanitize or normalize high-entropy callback payload logging.
5. Remove remaining startup/worker legacy prose from production logging.
6. Fix sidecar operational failures in monitor and backup jobs.
7. Normalize log file ownership and retrieval permissions.

## Incident Operator Minimum

For this deployment to stay LLM-ready, operators should be able to retrieve logs by:

- `event`
- `candidate_id`
- `telegram_id`
- `correlation_id`
- `result`
- time range

If centralized search is not available, on-host investigation becomes slower and more fragile.
