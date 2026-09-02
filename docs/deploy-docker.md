# Docker deployment

The blessed way to run a station: two containers and one shared data
volume, brought up with a single `docker compose up`. Everything smart
runs in the station container; stock nginx serves the rest as static
files.

## Quickstart

Requires Docker with the Compose plugin — no Node, no ffmpeg on your
machine (the station image carries both).

```sh
git clone https://github.com/egadsman/moviesaboard.git
cd moviesaboard
docker compose up
```

Open <http://localhost:8080/>. With no content configured, the station
generates the synthetic demo fixtures on first boot
(`MOVIESABOARD_DEMO=auto`) and a four-channel train-themed station is on
the air: guide, player, full schedule, vote page. The first-boot encode
runs up to four ffmpeg jobs in parallel, capped at the CPU count on
small machines; a boot that crashes mid-encode self-heals on restart,
keeping the finished titles and re-encoding only the rest.

The published ports listen on all interfaces with no authentication —
anyone who can reach the host can watch and vote. On a trusted LAN that
is the point; on an untrusted network, firewall the ports or publish on
localhost only by prefixing the mapping with an address: set
`MOVIESABOARD_HTTP_PORT=127.0.0.1:8080` in `.env`.

## What runs

- **station** — built from the repo Dockerfile. Imports content into
  `library.json`, plans and compiles the schedule, answers `/time` and
  `/api/` on an internal port. Never published to the host; only nginx
  talks to it.
- **web** — stock `nginx:alpine`. The only thing listening: it serves
  the viewer, the encoded content, and `schedule.json`, and proxies
  `/time` and `/api/` to the station.

Both containers mount the same data volume at `/data`:

```text
/data/content/<slug>/      encoded HLS titles (frozen layout)
/data/state/               series cursors, programming
/data/library.json         import output
/data/schedule.json        compiled schedule (replaced atomically)
/data/vendor/hls.min.js    copied from node_modules by station at boot
/data/certs/               fullchain.pem + privkey.pem when TLS is on
/data/station.config.json  operator config, optional (see Configuration)
```

The repo's `./web` directory is bind-mounted read-only into the web
container — the viewer being served is the checkout you are standing
in, so `git pull` updates it in place.

Caching follows one hard-won rule: viewer HTML, assets, and
`schedule.json` are served `Cache-Control: no-cache` so deploys and
replans reach browsers immediately, while the encoded content under
`/content/` never changes and is cached for a year.

## Configuration

Copy `.env.example` to `.env` and edit; Compose reads it automatically.
Every variable is optional — `docker compose up` with no `.env` runs
the demo station on port 8080.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MOVIESABOARD_HTTP_PORT` | `8080` | Published HTTP port (maps to web `:80`; always on). |
| `MOVIESABOARD_HTTPS_PORT` | `8443` | Published HTTPS port (maps to web `:443`; answers only when TLS is on). |
| `MOVIESABOARD_DATA` | `./station-data` | Host path or named volume mounted at `/data` in both containers. |
| `MOVIESABOARD_CONTENT` | *(empty)* | Existing frozen-layout content directory to mount at `/data/content` (station read-write, web read-only). Empty keeps content inside `MOVIESABOARD_DATA`. |
| `MOVIESABOARD_TLS` | `off` | `off`, `self-signed`, or `provided` — see [TLS](#tls). |
| `STATION_NAME` | `MoviesAboard` | Station name shown in the viewer. |
| `STATION_TZ` | *(empty)* | Station timezone (e.g. `America/Chicago`); empty uses the container's timezone. |
| `MOVIESABOARD_DEMO` | `auto` | `auto` generates demo fixtures when `/data/content` holds nothing beyond the demo's own titles and some are missing or broken (repairing a crashed encode — never beside real content); `off` never does. |
| `MOVIESABOARD_REPLAN_MINUTES` | `5` | How often the station checks whether the published schedule's week has ended and the new week needs planning. |

For anything the environment cannot express, the station also honors an
optional operator config at `/data/station.config.json` — station name
and timezone, the channel lineup, planner knobs, paths. Keys in the
file win; `STATION_NAME` and `STATION_TZ` fill in only what the file
omits. A file that is not valid JSON stops the boot instead of silently
airing the wrong station.

## TLS

`MOVIESABOARD_TLS` selects one of three modes:

- **`off`** (default) — plain HTTP on `MOVIESABOARD_HTTP_PORT`. At boot
  the web container sees no cert pair in `/data/certs/` and drops its
  443 server, so the HTTPS port simply does not answer.
- **`self-signed`** — the station generates a certificate pair into
  `/data/certs/` at boot. Browsers warn on first visit; fine for a LAN,
  a train car, or anywhere without public DNS.
- **`provided`** — you drop `fullchain.pem` and `privkey.pem` into
  `$MOVIESABOARD_DATA/certs/` yourself. This works with certbot (add a
  deploy hook that copies the renewed pair there) or a Cloudflare
  origin certificate. Run `docker compose restart web` after replacing
  the pair.

Real public TLS termination can also live entirely in front of the HTTP
port — a Cloudflare Tunnel, a Caddy or nginx reverse proxy with its own
certificates, or a cloud load balancer. Point it at
`http://your-host:8080` and leave `MOVIESABOARD_TLS=off`.

## Bring your own library

If you already have content in the frozen on-disk layout
(`content/<slug>/index.m3u8` + `seg-*.ts` + per-title `meta.json` — see
[contracts.md](contracts.md)), point `MOVIESABOARD_CONTENT` at it:

```sh
MOVIESABOARD_CONTENT=/srv/media/moviesaboard-content
```

It mounts at `/data/content`, and the station imports it at boot:
`library.json` is rebuilt from the `meta.json` files with **zero
re-encoding**. Because the import finds real titles, the demo fixtures
never generate.

## What persists across restarts

Everything under `/data` (`MOVIESABOARD_DATA`): content, the library,
`state/` cursors and programming, the compiled schedule, certificates.
Containers are disposable — `docker compose down`, rebuild, upgrade,
`up` again, and the station resumes where it was.

Votes do **not** persist. The open ballot and its counts live in the
station process's memory and reset when the container restarts. Durable
vote state (with the rest of the `state/` contract) arrives with
`stationd` in Phase 2.

## How the weekly replan works

Every `MOVIESABOARD_REPLAN_MINUTES` (default 5) the station checks
whether the published `schedule.json` is still the on-air week's (weeks
start Monday 00:00 in the station timezone). While it is, the tick does
nothing. On the first check after that week has ended — or when no
schedule is published at all — the planner writes programming for the
week containing now and the compiler produces a fresh `schedule.json`,
written atomically. So the timer fires often, but a new schedule is
published only once per week boundary. The compiler **refuses** invalid
schedules — overlaps, unknown slugs, impossible dates — so the
last-good schedule keeps serving no matter what. There is nothing to
cron.
