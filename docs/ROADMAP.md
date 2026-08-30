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

## Phase 2 — stationd + deploy (in progress)

Landed early: Docker Compose ([deploy-docker.md](deploy-docker.md), the
blessed deployment — `docker compose up` already airs a voting,
self-replanning station), frozen-layout import (`scripts/import.js`), and
the replan tick (in the station container, and as a bare-metal systemd
timer — [deploy-station.md](deploy-station.md)). Still to come: the
`stationd` daemon proper (durable vote state, `GET /api/now`, airing the
vote winner on the Requests channel), the `moviesaboard` CLI, and
`station.yaml` parsing + nginx vhost rendering (until then the operator
config is `station.config.json`).

## Phase 3 — Encoder + sources

Encode queue + ffmpeg HLS profile, directory scanner, Jellyfin source
plugin, ship step. Station-in-a-box complete.

## Phase 4+ — Directions

- Admin UI and richer API on stationd
- SQLite state backend
- Selectable subtitle/audio tracks (demuxed CMAF)
- Adaptive bitrate ladders
- Live channels
