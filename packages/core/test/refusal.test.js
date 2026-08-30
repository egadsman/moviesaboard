// Typed refusals: planWeek throws PlanError (problems collected across
// channels), compileSchedule refuses a programming version it does not
// understand. Companions to the per-module tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION,
  CompileError,
  PlanError,
  compileSchedule,
  planWeek,
  weekStart,
} from "../lib/index.js";

const zone = "UTC";
const config = {
  station: { name: "T", timezone: zone },
  channels: [
    { num: 1, name: "M", role: "movies" },
    { num: 2, name: "S", role: "series-grid" },
  ],
  planner: { movie_break_minutes: 2, grid_minutes: 15 },
};
// Monday 2026-08-24 00:00 UTC.
const weekStartMs = weekStart(zone, Date.UTC(2026, 7, 27));

test("planWeek: PlanError collects problems across channels", () => {
  // Library with neither movies nor episodes: both channels refuse.
  assert.throws(
    () => planWeek({ library: [], config, weekStartMs }),
    (err) => {
      assert.ok(err instanceof PlanError);
      assert.equal(err.name, "PlanError");
      assert.deepEqual(err.problems, [
        "channel 1: movies channel needs at least one movie",
        "channel 2: series-grid channel needs episodes",
      ]);
      return true;
    },
  );
});

test("planWeek stamps CONTRACT_VERSION into programming", () => {
  const library = [
    {
      slug: "m1",
      title: "M1",
      kind: "movie",
      runtime_s: 3600,
      hls: "content/m1/index.m3u8",
    },
    {
      slug: "s-01",
      title: "S1E1",
      kind: "episode",
      series: "s",
      season: 1,
      episode: 1,
      runtime_s: 600,
      hls: "content/s-01/index.m3u8",
    },
  ];
  const { programming } = planWeek({ library, config, weekStartMs });
  assert.equal(programming.version, CONTRACT_VERSION);
});

test("compileSchedule refuses a foreign programming version", () => {
  assert.throws(
    () =>
      compileSchedule({
        programming: { version: 999, week_start: "2026-08-24", channels: [] },
        library: [],
        config: { station: { name: "T", timezone: zone }, channels: [] },
        nowMs: 0,
      }),
    (err) => {
      assert.ok(err instanceof CompileError);
      assert.ok(err.problems.some((p) => p.includes("programming version")));
      return true;
    },
  );
});
