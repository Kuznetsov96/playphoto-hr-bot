# Logging Standard

## Goal

This bot uses logs as an incident-recovery surface, not as ad-hoc console output. The minimum standard is:

- `product` stream for operational flow and business events
- `audit` stream for privileged actions and state-changing accountability
- `security` events routed into the audit stream with higher severity semantics

The target outcome is that candidate flow, support/admin actions, and security incidents are reconstructable from logs without reading the code.

## Event Schema

Structured events should prefer this shape:

- `event`: `domain.entity.action`
- `candidate_id`
- `telegram_id`
- `actor_role`
- `stage`
- `result`
- `reason_code`
- `module`
- `operation`
- `safe_context`

Rules:

- `event` is the primary machine-readable signal.
- `safe_context` is for non-sensitive incident context only.
- Use `result` consistently: `started`, `success`, `failed`, `empty`, or another bounded enum.
- Use `reason_code` for stable failure classes, not free-form prose.
- Keep message text short and secondary to the JSON fields.

## Security And Privacy

Never log:

- raw Telegram payloads
- message text or captions unless explicitly sanitized and operationally required
- phone, email, full name, IBAN, passport, tax IDs
- cookies, tokens, passwords, proxy credentials, auth headers
- third-party response bodies unless reduced to a short safe summary

Required practices:

- log through the structured facade whenever possible
- prefer `err` / `error` objects over string interpolation
- keep third-party failure details in `safe_context` only if already sanitized
- avoid logging raw request/response objects from integrations

## Noise Budget

Allowed:

- one structured `started` event for a long-running operation
- one structured `success` / `failed` completion event
- targeted `warn` / `error` logs for recoveries, retries, or degraded mode

Avoid:

- emoji/debug prose as the primary signal
- per-item happy-path logs if an aggregate event already exists
- duplicate `logger.info` alongside an equivalent structured event
- noisy diagnostics that include user-readable copy or UI details

## Incident Recovery Checklist

During or after an incident, operators should be able to answer:

1. What happened?
2. Who triggered it?
3. Which candidate/user/staff entity was affected?
4. Which stage was active?
5. Did the action succeed, fail, retry, or degrade?
6. What is the stable reason code?
7. What follow-up action is safe and expected?

If the answer requires reading source code, the logging is incomplete.

## Infra Checklist

The repo cannot verify these infra items directly, but production should enforce them:

- Centralized sink for `stdout` plus persisted file shipping for `product` and `audit`
- Searchable retention with incident retrieval by `event`, `candidate_id`, `telegram_id`, `result`, and time range
- Separate index/stream routing for `product`, `audit`, and `security`
- Alerting on `security=true`, repeated `reason_code`, and job-level failure spikes
- Retention policy documented by stream:
  - `product`: short-to-medium operational retention
  - `audit`: longer retention for investigations and access/accountability
  - `security`: longest retention and restricted access
- Access control so only authorized operators can read audit/security streams
- Clock sync and timezone consistency across workers and log sinks

## Minimal Mandatory Standard

Every new feature touching production flows must:

- emit at least one structured start/completion event for critical operations
- use `domain.entity.action` naming
- keep PII/secrets out of logs by default
- route privileged/security actions into audit/security logging
- avoid duplicate ad-hoc happy-path logs when the structured event already exists
