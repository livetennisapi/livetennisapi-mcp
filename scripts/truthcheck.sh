#!/bin/sh
# Truth-pin: fail the build when stale product facts creep back into the repo.
#
# The quota grid changed on 2026-08-06 (FREE 100/day, BASIC 1,000, PRO 10,000,
# ULTRA 500,000) and copy drifts back toward the old numbers unless something
# mechanical objects. Same for the docs URL and the daily-reset story.
#
# CHANGELOG.md is exempt — its old entries legitimately describe old facts.
# This script is exempt from itself, since the forbidden strings appear below.
set -eu
cd "$(dirname "$0")/.."

EXCLUDE=":(exclude)CHANGELOG.md :(exclude)scripts/truthcheck.sh"
bad=0

forbid() { # $1 = pattern, $2 = why it is wrong
  # shellcheck disable=SC2086
  if git grep -inE "$1" -- . $EXCLUDE >/dev/null 2>&1; then
    echo "TRUTHCHECK FAIL: $2"
    git grep -inE "$1" -- . $EXCLUDE | head -5
    bad=1
  fi
}

# Old quota numbers in day-quota context.
forbid '100[,.]?000[^0-9]{0,12}(/|per )[ ]?day|100k[ ]?(/|per )[ ]?day' 'stale 100k/day quota (FREE is 100/day since 2026-08-06)'
forbid '[Ff]ree[^.]{0,60}\b1[,.]?000\b[^0-9]{0,12}(/|per )[ ]?day' 'FREE paired with 1,000/day (BASIC is 1,000; FREE is 100)'
# Wrong canonical URLs / identities / reset story.
forbid 'livetennisapi\.com/docs' 'wrong docs URL — it is https://docs.livetennisapi.com'
forbid 'bensynapse' 'personal identity in repo metadata — use the livetennisapi org'
forbid 'midnight UTC' 'daily quota does NOT reset at midnight UTC — the 429 body carries the exact resets_at instant'

# If the repo states quotas at all, the current FREE cap and docs URL must be present.
# shellcheck disable=SC2086
if git grep -qiE 'requests?[ /]?(per[ ])?day' -- . $EXCLUDE 2>/dev/null; then
  git grep -qE '100 requests/day|100/day' -- . $EXCLUDE 2>/dev/null \
    || { echo 'TRUTHCHECK FAIL: quotas are stated but "100 requests/day" (FREE) is missing'; bad=1; }
  git grep -q 'docs\.livetennisapi\.com' -- . $EXCLUDE 2>/dev/null \
    || { echo 'TRUTHCHECK FAIL: docs.livetennisapi.com is not referenced'; bad=1; }
fi

[ "$bad" -eq 0 ] && echo 'truthcheck OK — product facts current'
exit "$bad"
