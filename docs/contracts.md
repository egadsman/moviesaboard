# Data contracts

These four artifacts are MoviesAboard's stable API. Components communicate
through them and nothing else; each may be regenerated at any time from its
upstream inputs. Contract changes require an issue and a documented
migration path. Current `CONTRACT_VERSION`: **1**.

## 1. library.json

Manifest of ready-to-air content. Written atomically by the encoder, read by
everything else. One entry per title:

```text
{ slug, title, kind (movie|episode|interstitial|clip),
  series?, season?, episode?, runtime_s, artwork?,
  hls: "content/<slug>/index.m3u8", source, encoded_at, profile }
```

Entries are indistinguishable by origin — a Jellyfin-sourced episode and a
directory-scanned one look identical after encoding.

## 2. programming.json

One planned week of per-channel programming, regenerated wholesale by the
weekly planner from (library, config, cursors, week start) and written
tmp+rename to `state/programming.json` by the station compiler:

```text
{ version, week_start,
  channels: [{ num, role,
    days: [{ date, slots: [{ at: "HH:MM", slug }] }] }] }
```

Today it is a record of the plan, not an input: the compiler consumes the
freshly planned object directly, nothing reads the file back, and every
publishing replan overwrites it — hand edits neither survive a replan nor
reach the schedule. A run that publishes nothing (schedule still fresh
under `--check-stale`, `--dry-run`, refused plan or compile) leaves the
file untouched. The vote channel never appears here — vote channels
compile from the compiler's separate vote-placements input, which stays
empty until stationd (Phase 2) supplies vote winners.

## 3. schedule.json

Compiled output the viewer polls:

```text
{ generated, station: { name, timezone },
  channels: [{ num, name,
    airings: [{ slug, title, start, end, live, src }] }] }
```

`start`/`end` are absolute epoch milliseconds. The compiler is a
deterministic pure function of (programming, library, config, vote
placements, clock) and
**refuses** invalid schedules — overlaps, unknown slugs, impossible dates —
so the last-good schedule always keeps serving.

## 4. state/

Series cursors (`cursors.json`) and the planner's `programming.json`,
written directly by the interim station compiler today. The open ballot
and vote history join them when stationd lands (Phase 2), which will then
own `state/` exclusively through one small state module in core (JSON
files first, SQLite later, without touching business logic).

## On-disk HLS layout (frozen)

`content/<slug>/index.m3u8` + `seg-*.ts` + per-title `meta.json`. Slug
conventions: `ad-*` (interstitials), `clip-*` (shorts), `name-NN`
(episodes). Frozen so existing libraries migrate with **zero re-encoding**;
`scripts/import.js` builds `library.json` from a directory of existing
`meta.json` files today; the `moviesaboard` CLI wrapper arrives in
Phase 2.
