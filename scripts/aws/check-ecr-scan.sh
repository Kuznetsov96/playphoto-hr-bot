#!/usr/bin/env bash
set -euo pipefail

repository_name="${1:?ECR repository name is required}"
image_tag="${2:?ECR image tag is required}"
aws_region="${AWS_REGION:-eu-north-1}"
attempts="${ECR_SCAN_ATTEMPTS:-36}"
delay_seconds="${ECR_SCAN_DELAY_SECONDS:-10}"

temporary_response="$(mktemp)"
temporary_error="$(mktemp)"
trap 'rm -f "$temporary_response" "$temporary_error"' EXIT
scan_requested=false

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if aws ecr describe-image-scan-findings \
    --repository-name "$repository_name" \
    --image-id "imageTag=$image_tag" \
    --region "$aws_region" \
    --output json \
    >"$temporary_response" 2>"$temporary_error"
  then
    scan_status="$(jq -r '.imageScanStatus.status // "UNKNOWN"' "$temporary_response")"
    if [[ "$scan_status" == "COMPLETE" || "$scan_status" == "ACTIVE" ]]; then
      critical="$(jq -r '.imageScanFindings.findingSeverityCounts.CRITICAL // 0' "$temporary_response")"
      high="$(jq -r '.imageScanFindings.findingSeverityCounts.HIGH // 0' "$temporary_response")"
      echo "$repository_name:$image_tag scan complete: critical=$critical high=$high"
      if ((critical > 0 || high > 0)); then
        echo "Deployment blocked by high-severity ECR findings." >&2
        exit 1
      fi
      exit 0
    fi
    if [[ "$scan_status" == "FAILED" || "$scan_status" == "UNSUPPORTED_IMAGE" ]]; then
      echo "ECR scan cannot validate $repository_name:$image_tag (status: $scan_status)." >&2
      exit 1
    fi
  elif grep -q 'ScanNotFoundException' "$temporary_error" && [[ "$scan_requested" == false ]]; then
    aws ecr start-image-scan \
      --repository-name "$repository_name" \
      --image-id "imageTag=$image_tag" \
      --region "$aws_region" >/dev/null 2>&1 || true
    scan_requested=true
  elif ! grep -Eq 'ScanNotFoundException|LIMIT_EXCEEDED' "$temporary_error"; then
    sed -n '1,20p' "$temporary_error" >&2
    exit 1
  fi
  echo "Waiting for ECR scan of $repository_name:$image_tag ($attempt/$attempts)."
  sleep "$delay_seconds"
done

echo "Timed out waiting for ECR scan of $repository_name:$image_tag." >&2
exit 1
