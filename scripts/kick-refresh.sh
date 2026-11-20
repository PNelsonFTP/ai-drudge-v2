#!/bin/bash
# Start one AI DRUDGE V2 refresh on GitHub Actions (workflow_dispatch).
#
# Defaults point at V2. Override through the environment:
#   AID_REPO       owner/name                    default PNelsonFTP/ai-drudge-v2
#   AID_REF        branch the workflow runs on   default main
#   AID_WORKFLOW   workflow file name            default refresh.yml
#   AID_RETRIES    attempts before giving up     default 3 (15 s apart)
#   AID_DRY_RUN=1  print what would be kicked and exit without calling GitHub
#   AID_ALLOW_V1=1 required to kick the V1 repository on purpose
#
# Safe to copy outside ~/Documents for a launch agent (launchd cannot read this folder).
# Works with the stock macOS bash 3.2.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

REPO="${AID_REPO:-PNelsonFTP/ai-drudge-v2}"
REF="${AID_REF:-main}"
WORKFLOW="${AID_WORKFLOW:-refresh.yml}"
RETRIES="${AID_RETRIES:-3}"

# The V1 (live) repository, lower-cased. This script never dispatches to it by accident.
V1_REPO="pnelsonftp/ai-drudge"

die() {
  echo "kick-refresh: $*" >&2
  exit 1
}

# Accept owner/name, github.com/owner/name, a full https URL, or an ssh remote; reduce to owner/name.
REPO="${REPO#https://}"
REPO="${REPO#http://}"
REPO="${REPO#git@}"
REPO="${REPO#github.com/}"
REPO="${REPO#github.com:}"
# Strip EVERY trailing "/" and ".git" (a loop, not one pass): "owner/name.git.git" or
# "owner/name.git/" must not slip past the V1 check below as a different-looking name.
while :; do
  case "$REPO" in
    */) REPO="${REPO%/}" ;;
    *.git) REPO="${REPO%.git}" ;;
    *) break ;;
  esac
done

case "$REPO" in
  */*/*) die "AID_REPO must be owner/name (got '$REPO')" ;;
  */*) ;;
  *) die "AID_REPO must be owner/name (got '$REPO')" ;;
esac
case "$REPO" in
  *[!A-Za-z0-9._/-]*) die "AID_REPO contains unexpected characters ('$REPO')" ;;
esac
case "$REPO" in
  /* | */ | */. | */.. | ./* | ../*) die "AID_REPO must be owner/name (got '$REPO')" ;;
esac
case "$REF" in
  "" | -* | *[!A-Za-z0-9._/-]*) die "AID_REF is not a plain branch name ('$REF')" ;;
esac
case "$WORKFLOW" in
  "" | -* | *[!A-Za-z0-9._\ -]*) die "AID_WORKFLOW is not a plain workflow name ('$WORKFLOW')" ;;
esac
case "$RETRIES" in
  "" | *[!0-9]* | 0) die "AID_RETRIES must be a positive integer ('$RETRIES')" ;;
esac

repo_lc="$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
if [ "$repo_lc" = "$V1_REPO" ] && [ "${AID_ALLOW_V1:-0}" != "1" ]; then
  die "refusing to kick the V1 repository ($REPO). Set AID_REPO to the V2 repository, or AID_ALLOW_V1=1 if V1 is really what you mean."
fi

echo "kick-refresh: workflow '$WORKFLOW' in $REPO on ref '$REF'"

if [ "${AID_DRY_RUN:-0}" = "1" ]; then
  echo "kick-refresh: dry run - nothing dispatched"
  exit 0
fi

GH="$(command -v gh || true)"
[ -n "$GH" ] || die "gh (GitHub CLI) not found on PATH ($PATH)"

attempt=1
while :; do
  if "$GH" workflow run "$WORKFLOW" --repo "$REPO" --ref "$REF"; then
    echo "kick-refresh: dispatched at $(date -u +%FT%TZ) (attempt $attempt)"
    exit 0
  fi
  if [ "$attempt" -ge "$RETRIES" ]; then
    die "dispatch failed after $attempt attempt(s)"
  fi
  attempt=$((attempt + 1))
  sleep 15
done
