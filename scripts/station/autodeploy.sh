#!/usr/bin/env bash
# Manual update cycle for a MoviesAboard station host: fetch main, run
# the test suite on this hardware, deploy only when it passes, and
# append the result to a LOCAL append-only log. Nothing is pushed
# anywhere — review the log (or journald) to see how commits fared.
#
#   1. fetch origin/main (offline is fine — skip to the staleness check)
#   2. on new commits: reset --hard, re-exec the new script once,
#      npm ci, npm test — a failing suite blocks the deploy and the
#      last-good station keeps airing
#   3. deploy: sync web/ + hls.js into the public dir, then
#      station-compile (forced on new commits, --check-stale otherwise)
#   4. log one JSON line locally (deployed / test-failed / fresh ...)
#
# The weekly replan runs separately from moviesaboard-replan.timer;
# run THIS script by hand (or via `systemctl start
# moviesaboard-autodeploy`) when you want the host to pick up commits.
#
# Environment (all optional):
#   MOVIESABOARD_REPO    checkout to deploy from  (~/git/moviesaboard)
#   MOVIESABOARD_CONFIG  station.config.json      (/srv/moviesaboard/…)
#   MOVIESABOARD_LOG     result log               (~/moviesaboard-autodeploy.jsonl)
set -euo pipefail

REPO_DIR="${MOVIESABOARD_REPO:-$HOME/git/moviesaboard}"
CONFIG="${MOVIESABOARD_CONFIG:-/srv/moviesaboard/station.config.json}"
LOG_FILE="${MOVIESABOARD_LOG:-$HOME/moviesaboard-autodeploy.jsonl}"
LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/moviesaboard-autodeploy.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another autodeploy is running — leaving it alone"
  exit 0
fi

cd "$REPO_DIR"
STARTED_MS="$(date +%s)000"

PUBLIC_DIR="$(CONFIG="$CONFIG" node -e \
  'console.log(JSON.parse(require("fs").readFileSync(process.env.CONFIG,"utf8")).paths.public)')"

old_sha="$(git rev-parse HEAD)"
# After a self-update re-exec, HEAD is already the new sha — the pre-update
# sha rides through the environment so the deploy steps still run.
old_sha="${MOVIESABOARD_PREV_SHA:-$old_sha}"
offline=0
git fetch --quiet origin main || offline=1
new_sha="$(git rev-parse origin/main)"

action="fresh"
tests="skipped"
error=""

if [ "$offline" = 1 ]; then
  echo "offline (fetch failed) — continuing with the current checkout"
fi

if [ "$new_sha" != "$old_sha" ]; then
  echo "updating $old_sha -> $new_sha"
  git reset --hard --quiet "$new_sha"
  # The new commit may have changed this very script: run its version,
  # telling it where we came from so it still tests and deploys.
  if [ "${MOVIESABOARD_REEXEC:-0}" != 1 ]; then
    MOVIESABOARD_REEXEC=1 MOVIESABOARD_PREV_SHA="$old_sha" \
      exec "$REPO_DIR/scripts/station/autodeploy.sh" "$@"
  fi
fi

log_result() {
  # One JSON line per meaningful run, appended locally. Timestamps UTC.
  ACTION="$action" SHA="$new_sha" TESTS="$tests" ERR="$error" \
    STARTED="$STARTED_MS" node -e '
    const e=process.env;
    console.log(JSON.stringify({ts:new Date().toISOString(),
      sha:e.SHA,action:e.ACTION,tests:e.TESTS,
      duration_s:Math.round((Date.now()-Number(e.STARTED))/1000),
      ...(e.ERR?{error:e.ERR}:{})}))' >>"$LOG_FILE"
}

fail() {
  error="$1"
  echo "FAILED: $error"
  log_result
  exit 1
}

if [ "$new_sha" != "$old_sha" ]; then
  npm ci --silent --no-audit --no-fund || fail "npm ci failed"
  if npm test >/tmp/moviesaboard-test.log 2>&1; then
    tests="pass"
  else
    tests="fail"
    action="test-failed"
    tail -20 /tmp/moviesaboard-test.log
    fail "tests failed on $new_sha — not deploying"
  fi

  echo "deploying viewer + vendor"
  rsync -a web/ "$PUBLIC_DIR/"
  mkdir -p "$PUBLIC_DIR/vendor"
  cp node_modules/hls.js/dist/hls.min.js "$PUBLIC_DIR/vendor/hls.min.js"

  if node scripts/station-compile.js --config "$CONFIG"; then
    action="deployed"
  else
    fail "station-compile failed on $new_sha"
  fi
else
  out="$(node scripts/station-compile.js --config "$CONFIG" --check-stale)" ||
    fail "stale replan failed"
  printf '%s\n' "$out"
  case "$out" in
    *"published"*) action="replanned" ;;
    *) action="fresh" ;;
  esac
fi

echo "done: $action"
log_result
