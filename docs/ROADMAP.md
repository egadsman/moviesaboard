# Roadmap

MoviesAboard starts as a portable core with thin adapters and grows into a
long-running station service (`stationd`). The daemon gains jobs over time —
the modules and [data contracts](contracts.md) underneath do not change.
Build toward that: new smarts belong in pure core modules; stationd and the
CLI stay thin wrappers.

## Phase 0 — Bootstrap ✅

Repo, license, docs, config schema, CI skeleton.

## Phase 1 — Core + viewer ✅

`packages/core` (schedule compiler, week planner, interstitial packer, vote
tally, DST-correct time module — all pure, golden-file tested) and `web/`
(guide, player with server-clock sync and offset seek, full schedule, vote
page). Demo: `npm run demo` generates color-bar/tone fixture clips with
ffmpeg, compiles a schedule, serves it statically — clone → see TV, no
daemon required.

## Phase 2 — stationd + deploy (next)

Docker Compose landed early — [deploy-docker.md](deploy-docker.md) is the
blessed deployment. Still to come: the `stationd` daemon (scheduling ticks,
`POST /api/vote`, `GET /api/now`), the `moviesaboard` CLI, systemd unit +
nginx vhost rendering from `station.yaml`. Demo: `docker compose up` → a
voting, self-replanning station.

## Phase 3 — Encoder + sources

Encode queue + ffmpeg HLS profile, directory scanner, Jellyfin source
plugin, ship step. Station-in-a-box complete.

## Phase 4+ — Directions

- Admin UI and richer API on stationd
- SQLite state backend
- Selectable subtitle/audio tracks (demuxed CMAF)
- Adaptive bitrate ladders
- Live channels
