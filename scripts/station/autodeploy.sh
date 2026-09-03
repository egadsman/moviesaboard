#!/usr/bin/env bash
# Manual update cycle for a MoviesAboard station host: fetch main, run
# the test suite on this hardware, deploy only when it passes, and
# append the result to a LOCAL append-only log. Nothing is pushed
# anywhere — review the log (or journald) to see how commits fared.
#
#   1. fetch origin/main (offline is fine — skip to the staleness check)
#   2. on new commits: reset --hard, re-exec the new script once,
#      npm ci, npm test — a failing suite blocks the deploy AND puts
#      the checkout back on the last-good sha (with its node_modules),
#      so the replan timer never compiles from an untested tree
#   3. deploy: sync web/ + hls.js into the public dir, then
#      station-compile (forced on new commits, --check-stale otherwise)
#   4. log one JSON line locally (deployed / test-failed / fresh ...)
#
# Rollback: pin HEAD by hand (git reset --hard <old-sha>), then run
# with MOVIESABOARD_PREV_SHA=rollback — that skips the fetch and the
# reset to origin/main and tests + deploys the pinned HEAD itself.
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
rollback=0
if [ "${MOVIESABOARD_PREV_SHA:-}" = "rollback" ]; then
  # Rollback mode: the operator pinned HEAD by hand — deploy exactly
  # that. No fetch, no reset to origin/main, no re-exec; the test
  # suite still gates the deploy.
  rollback=1
elif [ -n "${MOVIESABOARD_PREV_SHA:-}" ]; then
  # After a self-update re-exec, HEAD is already the new sha — the
  # pre-update sha rides through the environment so the deploy steps
  # still run (and the checkout can be restored if they fail).
  old_sha="$MOVIESABOARD_PREV_SHA"
fi

offline=0
if [ "$rollback" = 1 ]; then
  new_sha="$old_sha"
else
  git fetch --quiet origin main || offline=1
  new_sha="$(git rev-parse origin/main)"
fi

# In rollback mode start from "rollback" so a run that fails before the
# deploy (e.g. npm ci) doesn't log a misleading "fresh"; later
# assignments (test-failed / replanned / ...) still override.
if [ "$rollback" = 1 ]; then
  action="rollback"
else
  action="fresh"
fi
tests="skipped"
error=""
restored=""

if [ "$offline" = 1 ]; then
  echo "offline (fetch failed) — continuing with the current checkout"
fi

if [ "$rollback" != 1 ] && [ "$new_sha" != "$old_sha" ]; then
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
    RESTORED="$restored" STARTED="$STARTED_MS" node -e '
    const e=process.env;
    console.log(JSON.stringify({ts:new Date().toISOString(),
      sha:e.SHA,action:e.ACTION,tests:e.TESTS,
      duration_s:Math.round((Date.now()-Number(e.STARTED))/1000),
      ...(e.ERR?{error:e.ERR}:{}),
      ...(e.RESTORED?{restored:e.RESTORED}:{})}))' >>"$LOG_FILE"
}

fail() {
  error="$1"
  echo "FAILED: $error"
  log_result
  exit 1
}

restore_last_good() {
  # The replan timer compiles next week's schedule from this checkout,
  # so a failing update must not stay on disk: put the last-good sha
  # (and its node_modules) back. Best effort — a restore that itself
  # fails is logged so the operator knows the tree needs a hand.
  if [ "$new_sha" = "$old_sha" ]; then
    # Rollback mode (or nothing moved): no git reset needed — HEAD
    # never left old_sha — but a failed `npm ci` has already deleted
    # node_modules, and the replan timer needs a usable tree. Reinstall
    # best-effort; the caller logs the failure either way.
    npm ci --silent --no-audit --no-fund || true
    return 0
  fi
  echo "restoring last-good $old_sha"
  if git reset --hard --quiet "$old_sha" &&
    npm ci --silent --no-audit --no-fund; then
    restored="$old_sha"
  else
    restored="failed"
    echo "WARNING: could not restore $old_sha — fix the checkout by hand" >&2
  fi
}

# First deploy: on a fresh clone old_sha == new_sha, which would take
# the no-op staleness branch forever and never install the viewer — the
# public dir would serve 404 with only schedule.json in it. A missing
# viewer forces the full deploy branch.
first_deploy=0
if [ ! -f "$PUBLIC_DIR/index.html" ] ||
  [ ! -f "$PUBLIC_DIR/vendor/hls.min.js" ]; then
  first_deploy=1
  echo "viewer missing from $PUBLIC_DIR — running a full deploy"
fi

if [ "$rollback" = 1 ] || [ "$first_deploy" = 1 ] ||
  [ "$new_sha" != "$old_sha" ]; then
  if ! npm ci --silent --no-audit --no-fund; then
    restore_last_good
    fail "npm ci failed"
  fi
  if npm test >/tmp/moviesaboard-test.log 2>&1; then
    tests="pass"
  else
    tests="fail"
    action="test-failed"
    tail -20 /tmp/moviesaboard-test.log
    restore_last_good
    fail "tests failed on $new_sha — not deploying"
  fi

  echo "deploying viewer + vendor"
  rsync -a web/ "$PUBLIC_DIR/"
  mkdir -p "$PUBLIC_DIR/vendor"
  cp node_modules/hls.js/dist/hls.min.js "$PUBLIC_DIR/vendor/hls.min.js"

  # Forced compile (no --check-stale): a mid-week deploy replans the
  # on-air week with already-advanced cursors — a deliberate, accepted
  # lineup shift when code changes. The --check-stale paths (the branch
  # below, and the replan timer) must instead never churn the on-air
  # week.
  if node scripts/station-compile.js --config "$CONFIG"; then
    if [ "$rollback" = 1 ]; then
      action="rollback"
    else
      action="deployed"
    fi
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
