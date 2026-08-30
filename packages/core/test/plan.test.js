import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planWeek } from "../lib/plan.js";
import {
  addDays,
  epochToWall,
  formatWallDate,
  parseHM,
  parseWallDate,
  wallToEpoch,
} from "../lib/time.js";

const LIBRARY = JSON.parse(
  readFileSync(new URL("./fixtures/plan.library.json", import.meta.url)),
);
const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/plan.golden.json", import.meta.url)),
);

const ZONE = "America/Chicago";
const CONFIG = {
  station: { name: "MoviesAboard", timezone: ZONE },
  channels: [
    { num: 1, name: "Features", role: "movies" },
    { num: 2, name: "Grid", role: "series-grid" },
    { num: 3, name: "Marathon", role: "marathon" },
    { num: 4, name: "Vote", role: "vote" },
  ],
  planner: { movie_break_minutes: 15, grid_minutes: 60 },
};

// Monday 2026-08-24 00:00 CDT. Hand derivation: 2026-01-01T00:00:00Z is
// 1767225600s (1704067200s for 2024-01-01, + 366d + 365d); Aug 24 is day
// 235 of 2026, so 00:00Z is 1767225600 + 235*86400 = 1787529600s; CDT is
// UTC-5, so 00:00 local = 05:00Z = 1787547600s = 1787547600000ms.
const WEEK1_MS = 1787547600000;

function plan(overrides = {}) {
  return planWeek({
    library: LIBRARY,
    config: CONFIG,
    weekStartMs: WEEK1_MS,
    ...overrides,
  });
}

// Walk a programming object the way the compiler will: turn every
// date + "HH:MM" back into an instant with wallToEpoch and check that no
// airing starts before the previous one (on any earlier day) has ended,
// that every slug exists, and that each channel has 7 correctly dated
// days. This is the planner's core promise.
function assertCompilable(programming, weekStartMs) {
  const bySlug = new Map(LIBRARY.map((e) => [e.slug, e]));
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(formatWallDate(epochToWall(ZONE, addDays(ZONE, weekStartMs, i))));
  }
  assert.equal(programming.version, 1);
  assert.equal(programming.week_start, dates[0]);
  for (const ch of programming.channels) {
    assert.deepEqual(
      ch.days.map((d) => d.date),
      dates,
      `channel ${ch.num} must have the 7 week dates in order`,
    );
    let prevEnd = -Infinity;
    for (const day of ch.days) {
      const { year, month, day: dd } = parseWallDate(day.date);
      for (const slot of day.slots) {
        const { hour, minute } = parseHM(slot.at); // throws if malformed
        const start = wallToEpoch(ZONE, { year, month, day: dd, hour, minute });
        assert.ok(
          start >= prevEnd,
          `channel ${ch.num} ${day.date} ${slot.at} overlaps previous airing`,
        );
        const entry = bySlug.get(slot.slug);
        assert.ok(entry, `channel ${ch.num} unknown slug ${slot.slug}`);
        prevEnd = start + entry.runtime_s * 1000;
      }
    }
  }
}

test("golden: week of 2026-08-24 matches plan.golden.json", () => {
  assert.deepEqual(plan(), GOLDEN);
});

test("deterministic: identical inputs give identical output", () => {
  assert.deepEqual(plan(), plan());
});

test("does not mutate its inputs", () => {
  const library = structuredClone(LIBRARY);
  const config = structuredClone(CONFIG);
  const cursors = { movies_index: 1, marathon_index: 1, series: { "night-shift": 2 } };
  planWeek({ library, config, cursors, weekStartMs: WEEK1_MS });
  assert.deepEqual(library, LIBRARY);
  assert.deepEqual(config, CONFIG);
  assert.deepEqual(cursors, {
    movies_index: 1,
    marathon_index: 1,
    series: { "night-shift": 2 },
  });
});

test("vote channels never appear in programming", () => {
  const { programming } = plan();
  assert.deepEqual(
    programming.channels.map((c) => [c.num, c.role]),
    [
      [1, "movies"],
      [2, "series-grid"],
      [3, "marathon"],
    ],
  );
});

test("week 1 compiles: 7 dated days per channel, no overlaps", () => {
  assertCompilable(plan().programming, WEEK1_MS);
});

test("movies: 00:00 Monday open, 5-minute boundaries, break respected", () => {
  const { programming } = plan();
  const movies = programming.channels[0];
  assert.equal(movies.days[0].slots[0].at, "00:00");
  const bySlug = new Map(LIBRARY.map((e) => [e.slug, e]));
  let prevEnd = null; // minutes into the week, no DST in this week
  for (const [d, day] of movies.days.entries()) {
    for (const slot of day.slots) {
      const { hour, minute } = parseHM(slot.at);
      assert.equal(minute % 5, 0, `${slot.at} not on a 5-minute boundary`);
      const startMin = d * 1440 + hour * 60 + minute;
      if (prevEnd !== null && startMin !== d * 1440) {
        // Except at a fresh-midnight open, the break separates features.
        assert.ok(
          startMin >= prevEnd + CONFIG.planner.movie_break_minutes,
          `${day.date} ${slot.at} starts inside the movie break`,
        );
      }
      prevEnd = startMin + bySlug.get(slot.slug).runtime_s / 60;
    }
  }
});

test("grid: a long episode occupies the following slot too", () => {
  const { programming } = plan();
  const grid = programming.channels[1];
  let seen = 0;
  for (const day of grid.days) {
    for (const [i, slot] of day.slots.entries()) {
      if (slot.slug !== "paper-trail-02") continue; // 70min in a 60min grid
      seen += 1;
      if (i + 1 < day.slots.length) {
        const cur = parseHM(slot.at);
        const next = parseHM(day.slots[i + 1].at);
        assert.equal(
          next.hour * 60 + next.minute - (cur.hour * 60 + cur.minute),
          120,
          `next airing after ${slot.at} paper-trail-02 must skip a grid line`,
        );
      }
    }
  }
  assert.ok(seen > 0, "fixture week should air paper-trail-02");
});

test("cursors: week 2 continues where week 1 ended", () => {
  const week1 = plan();
  const WEEK2_MS = addDays(ZONE, WEEK1_MS, 7);
  const week2 = plan({ cursors: week1.cursors, weekStartMs: WEEK2_MS });
  assertCompilable(week2.programming, WEEK2_MS);

  // Movies: the first feature of week 2 is the next unplayed one after
  // week 1's final feature (features sorted by slug, rotation of 2).
  const features = ["depot-nocturne", "the-big-heist"];
  const lastSlug = week1.programming.channels[0].days[6].slots.at(-1).slug;
  const expected = features[(features.indexOf(lastSlug) + 1) % 2];
  assert.equal(week2.programming.channels[0].days[0].slots[0].slug, expected);
  assert.equal(features[week1.cursors.movies_index], expected);

  // Marathon: 7 days advance the series rotation by 7 (odd), so week 2
  // opens with the other series.
  assert.equal(week1.cursors.marathon_index, 1);
  assert.match(
    week1.programming.channels[2].days[0].slots[0].slug,
    /^night-shift/,
  );
  assert.match(
    week2.programming.channels[2].days[0].slots[0].slug,
    /^paper-trail/,
  );

  // Grid: week 2's first slot for each series picks up at the stored
  // per-series episode cursor.
  const gridDay0 = week2.programming.channels[1].days[0].slots;
  const nsIdx = week1.cursors.series["night-shift"];
  assert.equal(gridDay0[0].slug, `night-shift-0${nsIdx + 1}`);
});

test("cursors: explicit indexes select the starting content", () => {
  const { programming } = plan({
    cursors: {
      movies_index: 1,
      marathon_index: 1,
      series: { "night-shift": 2, "paper-trail": 1 },
    },
  });
  // features[1] = the-big-heist opens the week.
  assert.equal(programming.channels[0].days[0].slots[0].slug, "the-big-heist");
  // Marathon day 0 rotates to series[1] = paper-trail.
  assert.match(programming.channels[2].days[0].slots[0].slug, /^paper-trail/);
  // Grid: night-shift starts at episode index 2, paper-trail at 1.
  const day0 = programming.channels[1].days[0].slots;
  assert.equal(day0[0].slug, "night-shift-03");
  assert.equal(day0[1].slug, "paper-trail-02");
});

test("DST fall-back week: valid clean slots, still compilable", () => {
  // Week containing the 2026-11-01 fall-back (25-hour Sunday) in Chicago.
  const DST_MS = wallToEpoch(ZONE, { year: 2026, month: 10, day: 26 });
  const { programming } = planWeek({
    library: LIBRARY,
    config: CONFIG,
    weekStartMs: DST_MS,
  });
  assertCompilable(programming, DST_MS);
  for (const ch of programming.channels) {
    const sunday = ch.days[6];
    assert.equal(sunday.date, "2026-11-01");
    assert.ok(sunday.slots.length > 0);
    for (const slot of sunday.slots) {
      assert.match(slot.at, /^\d{2}:\d{2}$/);
      parseHM(slot.at); // in-range
    }
  }
});

test("rejects a weekStartMs that is not Monday midnight", () => {
  assert.throws(
    () => plan({ weekStartMs: WEEK1_MS + 60000 }),
    /Monday 00:00/,
  );
  assert.throws(
    () => plan({ weekStartMs: addDays(ZONE, WEEK1_MS, 1) }),
    /Monday 00:00/,
  );
});

test("rejects unknown channel roles and unfillable channels", () => {
  const badRole = structuredClone(CONFIG);
  badRole.channels[0].role = "shuffle";
  assert.throws(() => plan({ config: badRole }), /unknown role "shuffle"/);

  const noMovies = LIBRARY.filter((e) => e.kind !== "movie");
  assert.throws(
    () => plan({ library: noMovies }),
    /needs at least one movie/,
  );
});
