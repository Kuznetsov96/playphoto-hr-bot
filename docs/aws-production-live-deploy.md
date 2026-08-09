# AWS production bot live deployment

`Deploy AWS production bot` replaces only an already-live AWS Telegram poller. It is not an initial
cutover mechanism and refuses to activate live mode when the existing container is standby or has an
unknown command.

## Release invariants

- The image is an ECR reference pinned to an immutable `sha256` digest.
- `BUSINESS_DATA_SOURCE=aws` is rebuilt from Secrets Manager on every release.
- The schedule shadow flag is an explicit workflow input and defaults to `false`.
- `BeforeInstall` verifies that the installed immutable image matches the running container.
- `BeforeInstall` records the actual `start:live` or `start:standby` command rather than trusting an
  older `release.env` label.
- Application start and service validation each require the same container to remain healthy without
  restarts for 60 seconds.
- A live deployment is accepted only when the existing AWS bot is already live. Initial cutover still
  uses `set-production-mode.sh` and its explicit legacy-stop confirmation.

## Rollback bootstrap

Revisions deployed before this mechanism were labelled `standby`, even after the bot was manually
switched to live mode. Rolling back to one of those revisions would stop Telegram polling.

The workflow therefore inspects the last successful CodeDeploy artifact:

1. If it contains `LIVE_SAFE_ROLLBACK_VERSION=1` and `BOT_RUNTIME_MODE=live`, normal CodeDeploy
   automatic rollback remains enabled.
2. If it does not, only that bootstrap deployment disables the per-deployment CodeDeploy rollback
   override. The lifecycle hooks retain the verified current image, compose files, environment and
   actual runtime mode under `/opt/playphoto-bot/.rollback`.
3. Any application-start or validation failure restores that captured immutable runtime before the
   deployment is reported failed.
4. After the first successful live-safe deployment, it becomes the CodeDeploy rollback baseline and
   subsequent deployments again use the deployment group's normal automatic rollback.

The deployment group configuration itself is not changed.

## Operator sequence

1. Confirm the legacy host has no running Telegram poller.
2. Confirm the AWS container is healthy with command `start:live` and zero unexpected restarts.
3. Confirm the backend internal API authenticated smoke succeeds from the bot container.
4. Dispatch the workflow for the reviewed commit with `schedule_shadow_enabled=false`.
5. Wait for build, ECR scan, CodeDeploy hooks and 60-second live validation to complete.
6. Confirm the container still runs `start:live`, uses `BUSINESS_DATA_SOURCE=aws`, and has the expected
   schedule shadow flag.
7. Confirm no second poller exists before considering the release complete.

Do not enable schedule shadow telemetry in the same deployment that introduces a new bot image.
