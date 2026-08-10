# AWS employee schedule shadow read

This migration slice compares the employee's canonical planned schedule from the PlayPhoto backend
with the projected `WorkShift` rows in the bot database. It never changes the Telegram response and
does not write canonical business data.

## Safety properties

- Disabled by default with `AWS_SCHEDULE_SHADOW_READ_ENABLED=false`.
- Runs only when `BUSINESS_DATA_SOURCE=aws`.
- Uses canonical employee and schedule UUIDs, not Telegram IDs.
- Calls the authenticated internal endpoint
  `GET /api/v1/internal/bot/employees/{employeePublicId}/schedule?from=&to=`.
- Returns the existing legacy schedule to the user even if the API is unavailable or disagrees.
- Logs aggregate counts only; shift UUIDs, employee UUIDs, Telegram IDs, names, and schedule details
  are not logged.
- Does not introduce dual writes or another source of truth.

## Deployment order

1. Deploy the backend endpoint with the flag still absent or `false` in the bot runtime secret.
2. Verify an authenticated request for a known mapped employee returns HTTP 200 and a minimal
   schema-versioned response.
3. Dispatch `Deploy AWS production bot` with `schedule_shadow_enabled=false`. The workflow must
   replace an already-live AWS poller and validate 60 seconds of stable `start:live` health.
4. In a separate controlled deployment, dispatch the same workflow with
   `schedule_shadow_enabled=true`. Do not change `BUSINESS_DATA_SOURCE` during this step.
5. Monitor `bot.aws_schedule_shadow.compared`, `bot.aws_schedule_shadow.failed`, and
   `bot.aws_schedule_shadow.skipped` events for an agreed observation window.

`bot.aws_schedule_shadow.compared` contains only:

- requested date window and display limit;
- canonical and legacy counts;
- matched, changed, missing, and unmapped counts;
- duration and the `parity`/`mismatch` result.

## Rollback

Dispatch `Deploy AWS production bot` for the last known-good commit with
`schedule_shadow_enabled=false`. No data rollback or backfill is required because the slice performs
only reads and telemetry logging. The legacy user-visible path remains unchanged.

Do not switch the user-visible result to the canonical API until the agreed parity threshold is met
and mismatches have been classified. Do not delete `WorkShift` or disable the snapshot projection as
part of this slice.
