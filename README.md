# MoviesAboard

**Run your own linear TV station from your media library.** Encode once,
schedule automatically, watch in any browser: a channel guide, a clock, and
viewer voting.

> **Status: alpha.** Working today (see Quickstart): the pure scheduling
> core, the web viewer with join-in-progress playback, the fixture-built
> demo station, the Docker Compose deployment (self-replanning; votes
> recorded in memory), and zero-re-encode import of an already-encoded
> library (`scripts/import.js`). Not yet: the encoder that turns your
> own media into HLS, `station.yaml` config, and durable votes that put
> the winner on air — see the [roadmap](docs/ROADMAP.md). The
> [data contracts](docs/contracts.md) are settled.

## Quickstart

Requires Node 20+ and ffmpeg on your PATH (`brew install ffmpeg` /
`apt install ffmpeg`).

```sh
git clone https://github.com/egadsman/moviesaboard.git
cd moviesaboard
npm install
npm run demo
```

Then open <http://localhost:4321/> — a four-channel station is on the air,
built from synthetic train-themed fixture clips: channel surfing, a live
guide, the full schedule, and a working vote page. Everything is generated
into the git-ignored `demo-dist/` and reused on the next run.

Or run the same station in Docker — no Node or ffmpeg on your machine:

```sh
docker compose up
```

Then open <http://localhost:8080/>. See
[docs/deploy-docker.md](docs/deploy-docker.md) for configuration, TLS,
and pointing the station at an existing library.

Either way, the station listens on all interfaces with no
authentication — anyone on your network can watch and vote, which on a
trusted LAN is the point. On an untrusted network, firewall the port
(the demo server takes no bind address) or publish the Docker port on
localhost only: `MOVIESABOARD_HTTP_PORT=127.0.0.1:8080` in `.env`.

## How it works

No transcoding at watch time, no player accounts, no "resume watching."
Content is encoded **once** into static HLS; a planner compiles a weekly
schedule pinned to real clock time; the viewer syncs to the server clock and
seeks into whatever is airing *right now*. Changing channels feels like
channel surfing, not browsing a catalog.

```text
media sources (directory scan · Jellyfin)
        │  encode once → static HLS
        ▼
  library.json ──► planner / compiler ──► schedule.json
                        │                      │
                        ▼                      ▼
                programming.json     static web viewer + tiny API
                (record of the plan) (guide · player · clock · vote)
```

Everything smart is a pure Node module; a small station process (today
the Docker entrypoint, eventually the `stationd` daemon) runs the
scheduling ticks and a tiny internal API; nginx serves the rest as static
files. Ships both as Docker Compose and bare-metal (systemd timer +
nginx) — same modules, same config, either target.

MoviesAboard does not depend on nginx. Any web server can air a station if
it serves static files with the HLS MIME types (`.m3u8` as
`application/vnd.apple.mpegurl`, `.ts` as `video/mp2t`), serves
`schedule.json` uncached, and sends a `Date` header — every server does,
and the viewer's clock sync falls back to it when `/time` is absent.
Voting needs the tiny API proxied through; without it the vote page
degrades to "voting offline". nginx is simply the blessed,
batteries-included path: the Docker deployment below uses it, and Phase 2
renders bare-metal vhosts from `station.yaml`.

## Why linear TV

Because choosing is a chore and channel surfing is a joy. A schedule you
don't control, shared with the people watching next to you, turns a media
library back into television — complete with a channel that airs whatever
the viewers vote for next.

## Origin

MoviesAboard was built to run a TV station aboard a cross-country train
trip: one small Linux box, no internet, a train car full of friends, and a
channel guide glowing on every phone. This repo is the generalized,
open-source version of that system.

## License

Copyright (C) 2026 egadsman and the MoviesAboard contributors.

[AGPL-3.0-or-later](LICENSE). Use it, fork it, run a station — and if you
distribute a modified version or run one as a network service, share your
changes under the same license.
