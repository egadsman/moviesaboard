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

## 2. programming.yaml

The human- and planner-editable curation layer: per-channel weekly
structure, curated series/feature lists, hand-placed one-offs. The weekly
planner rewrites it; future-dated hand edits survive the rewrite. The vote
channel never appears here — vote-winner placements are recorded in `state/`
by stationd and merged at compile time.

## 3. schedule.json

Compiled output the viewer polls:

```text
{ generated, station: { name, timezone },
  channels: [{ num, name,
    airings: [{ slug, title, start, end, live, src }] }] }
```

`start`/`end` are absolute epoch milliseconds. The compiler is a
deterministic pure function of (programming, library, cursors, clock) and
**refuses** invalid schedules — overlaps, unknown slugs, impossible dates —
so the last-good schedule always keeps serving.

## 4. state/

Series cursors, the open ballot, vote history. Owned exclusively by
stationd; all access goes through one small state module in core (JSON files
today, SQLite later, without touching business logic).

## On-disk HLS layout (frozen)

`content/<slug>/index.m3u8` + `seg-*.ts` + per-title `meta.json`. Slug
conventions: `ad-*` (interstitials), `clip-*` (shorts), `name-NN`
(episodes). Frozen so existing libraries migrate with **zero re-encoding**;
`moviesaboard import` (Phase 2) builds `library.json` from a directory of
existing `meta.json` files.
