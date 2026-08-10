#!/usr/bin/env bash
# Read-only report on the replacement shadow observation window (checkpoint A).
#
# Prints how often the canonical candidate search agreed with the legacy one, why
# comparisons were skipped, and the total limitedOnlyInLegacyCount — the count of
# people legacy marked LIMITED from a spreadsheet cell colour whom the canonical
# data does not restrict. A large number there is the expected outcome: it is the
# defect this migration exists to fix, not a regression.
#
# Usage: ./scripts/aws/check-shadow-window.sh [since]        e.g. 24h, 7d. Default 7d.
set -euo pipefail

SINCE="${1:-7d}"
INSTANCE_ID="${INSTANCE_ID:-i-0285c36d4f870dc30}"
PROFILE="${AWS_PROFILE:-playphoto}"
REGION="${AWS_REGION:-eu-north-1}"

remote=$(cat <<REMOTE
L() { docker logs playphoto-bot-bot-1 --since ${SINCE} 2>&1; }
echo "=== flags ==="
docker inspect playphoto-bot-bot-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'AWS_REPLACEMENTS_' | sort
echo "=== outcomes (parity vs mismatch) ==="
L | grep 'bot.replacement_shadow.compared' | grep -oE '"result":"[a-z]+"' | sort | uniq -c || echo "  none yet"
echo "=== skipped, by reason ==="
L | grep 'bot.replacement_shadow.skipped' | grep -oE '"reason_code":"[A-Z_]+"' | sort | uniq -c || echo "  none"
echo "=== failed (count) ==="
L | grep -c 'bot.replacement_shadow.failed' || true
echo "=== limitedOnlyInLegacyCount (the fix, quantified) ==="
L | grep -oE '"limitedOnlyInLegacyCount":[0-9]+' | cut -d: -f2 | awk '{s+=\$1} END {print "  total " (NR ? s : 0) " across " NR " comparisons"}'
echo "=== canonical wave present in preview? ==="
L | grep -oE '"canonicalWaveFound":(true|false)' | sort | uniq -c || echo "  none yet"
echo "=== replacement requests started in window ==="
L | grep -c 'Replacement request started' || true
REMOTE
)

# SSM runs each array element as its own line; passing one blob with embedded
# newlines silently executes only the first statement.
payload=$(printf '%s' "$remote" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().splitlines()))')

command_id=$(aws --profile "$PROFILE" --region "$REGION" ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters "commands=$payload" \
  --query 'Command.CommandId' --output text)

for _ in $(seq 1 40); do
  status=$(aws --profile "$PROFILE" --region "$REGION" ssm get-command-invocation \
    --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$status" in Success|Failed|TimedOut) break ;; esac
  sleep 3
done

aws --profile "$PROFILE" --region "$REGION" ssm get-command-invocation \
  --command-id "$command_id" --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' --output text

cat <<'GATE'

--- thresholds to proceed to the canonical switchover (Task 7) ---
  AMBIGUOUS_SHIFT   < 5% of comparisons
  .failed           < 1%
  >= 20 replacement requests observed, or 7 days elapsed
  divergence on the LIMITED waves documented as expected before flipping the flag
GATE
