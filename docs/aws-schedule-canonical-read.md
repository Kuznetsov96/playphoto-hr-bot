# AWS canonical schedule read

The Telegram `My Schedule` view can use the authenticated PlayPhoto backend schedule as its primary
business source with `AWS_SCHEDULE_CANONICAL_READ_ENABLED=true`.

## Ownership and compatibility

- Dates, times, shift identity and canonical location identity come from the backend API.
- Local `Location` and `WorkShift` rows are used only as technical mappings for Telegram display,
  replacement-request linkage and the existing colleagues overlay.
- Active and accepted Telegram replacement state remains overlaid on the canonical base schedule.
- Missing employee, location or shift mappings cause an aggregate-only fallback event and return the
  legacy projection. The view never mixes a partial canonical response with legacy business fields.
- API failures return the legacy projection and emit `bot.aws_schedule_canonical_read.fallback` without
  identifiers or schedule content.
- The user-visible canonical request has a three-second deadline before the atomic legacy fallback.
- Successful reads emit `bot.aws_schedule_canonical_read.succeeded` with count, limit and duration only.

## Enablement gate

Before enabling the flag, run an all-staff read-only parity audit for the same 62-day window. Require:

- every active staff profile mapped to a canonical employee;
- zero API/schema failures;
- zero changed, missing or unmapped shifts;
- a verified immutable rollback image and live CodeDeploy baseline.

Dispatch `Deploy AWS production bot` with `canonical_schedule_enabled=true`. Keep the existing
business source and immutable rollback configuration unchanged.

## Rollback

Dispatch the last known-good commit with `canonical_schedule_enabled=false`. No data rollback is
needed: this path performs reads only and does not change either database.
