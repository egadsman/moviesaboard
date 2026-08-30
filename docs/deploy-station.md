# Station host deployment (bare metal)

A station host serves everything through its own web server (nginx or
anything meeting the README's server requirements) and runs two small
pieces from this repo:

- **Replan timer** — `moviesaboard-replan.timer` probes every 15 minutes
  and recompiles the schedule only when the published week is running
  out. This is what keeps a station airing forever untouched.
- **Manual update cycle** — `scripts/station/autodeploy.sh`, run by hand
  (or via `systemctl start moviesaboard-autodeploy`) when you want the
  host to pick up new commits: it fetches `main`, runs the full test
  suite on the host's own hardware, deploys only when tests pass, and
  appends one JSON line per run to a local log
  (`MOVIESABOARD_LOG`, default `~/moviesaboard-autodeploy.jsonl`).
  Nothing is pushed anywhere; a failing suite leaves the last-good
  station airing and the failure in the log.

Offline is a first-class state: a failed fetch degrades to the
staleness check, so the weekly replan works with no network at all.

## What a deploy touches

- `<paths.public>/` gains the viewer pages and `vendor/hls.min.js`.
- `<paths.public>/schedule.json` is replaced atomically; the compiler
  refuses invalid schedules, so the last-good one keeps serving.
- `<paths.root>/library.json` and `<paths.state>/` are rewritten
  atomically. Encoded content is never touched.

## One-time host setup

1. Clone the repo (public — no credentials needed) as the account that
   will own the station:

   ```sh
   git clone https://github.com/egadsman/moviesaboard.git ~/git/moviesaboard
   ```

2. Write the operator config, e.g.
   `/srv/moviesaboard/station.config.json` (shape documented at the top
   of `scripts/station-compile.js`). It lives outside the repo;
   `station.yaml` support arrives in Phase 2.

3. Dry-run before going live:

   ```sh
   node scripts/import.js /srv/moviesaboard/public/content --dry-run
   node scripts/station-compile.js --config .../station.config.json --dry-run
   ```

4. Install the units. First edit `User=` and the paths in both service
   files to your station account; host-specific settings
   (`MOVIESABOARD_CONFIG`, `MOVIESABOARD_LOG`) belong in a systemd
   drop-in, not in the unit:

   ```sh
   sudo cp deploy/station/moviesaboard-*.service \
     deploy/station/moviesaboard-replan.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now moviesaboard-replan.timer
   ```

## Updating the station

```sh
sudo systemctl start moviesaboard-autodeploy   # or run the script directly
tail ~/moviesaboard-autodeploy.jsonl           # deployed / test-failed / …
```

GitHub CI runs the same tests on every push and pull request; the
host's run is the gate for what actually airs on that host.

## Rollback

Stop, pin, redeploy:

```sh
git -C ~/git/moviesaboard reset --hard <old-sha>
MOVIESABOARD_PREV_SHA=rollback ~/git/moviesaboard/scripts/station/autodeploy.sh
```

(The next manual update returns to `origin/main`.)
