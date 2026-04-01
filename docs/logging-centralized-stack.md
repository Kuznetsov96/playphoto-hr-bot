# Centralized Logging Stack

This project uses a local centralized logging stack on the production host:

- `Loki` for searchable log storage
- `Alloy` for log collection and shipping

This choice follows current Grafana guidance: use Alloy as the collector for Loki.

## Why This Exists

Without a centralized sink, incident investigation depends on manual `tail`, `grep`, and fragile on-host recovery. That is not good enough for fast incident response or reliable LLM-assisted debugging.

The centralized stack solves that by collecting these streams into one searchable place:

- `product`
- `audit`
- `security`
- `ops`

## Security Model

Loki and Alloy are bound to localhost only:

- `127.0.0.1:3100` for Loki
- `127.0.0.1:12345` for Alloy

This means they are not exposed publicly. Access requires SSH to the production host.

## Ingested Streams

Alloy ingests:

- `/home/playphoto-mgr/playphoto_hr_bot/logs/product.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/audit.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/security.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/monitor.log`
- `/home/playphoto-mgr/playphoto_hr_bot/logs/backup.log`

Loki labels kept intentionally low-cardinality:

- `app=playphoto_hr_bot`
- `host=playphoto`
- `job=playphoto_hr_bot`
- `logical_stream=product|audit|security|ops`
- `source=file`
- `ops_log=monitor|backup` for ops logs only

High-cardinality values such as `telegram_id`, `candidate_id`, and `correlation_id` remain in the JSON log body and should be queried from the log content, not stored as labels.

## Retention

Current Loki retention is:

- `31 days` (`744h`)

File retention remains app-managed:

- `product`: monthly rotation
- `audit`: quarterly rotation, 365-day archive retention
- `security`: quarterly rotation, 730-day archive retention

## Safe Query Examples

Basic readiness checks:

```bash
ssh playphoto 'curl -fsS http://127.0.0.1:3100/ready && echo'
ssh playphoto 'curl -fsS http://127.0.0.1:12345/-/ready && echo'
```

Recent product logs:

```bash
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range \
  --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="product"}'\'' \
  --data-urlencode '\''limit=20'\'''
```

Recent security logs:

```bash
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range \
  --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="security"}'\'' \
  --data-urlencode '\''limit=20'\'''
```

Find a Telegram user inside product logs:

```bash
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range \
  --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="product"} | json | telegram_id="944643678"'\'' \
  --data-urlencode '\''limit=20'\'''
```

Find a specific business event:

```bash
ssh playphoto 'curl -Gs http://127.0.0.1:3100/loki/api/v1/query_range \
  --data-urlencode '\''query={app="playphoto_hr_bot",logical_stream="product"} | json | event="candidate.screening.completed"'\'' \
  --data-urlencode '\''limit=20'\'''
```

## Operational Rule

During incidents:

1. query Loki first
2. use on-host `tail` and `grep` only as fallback
3. read code only after logs are insufficient
