// Typed refusals: planWeek throws PlanError (problems collected across
// channels), compileSchedule refuses a programming version it does not
// understand and defective library entries. Companions to the per-module
// tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

// Minimal one-channel compile input. Fresh objects every call so tests
// can mutate the library without cross-talk.
function compileInput(library) {
  return {
    programming: {
      version: CONTRACT_VERSION,
      week_start: "2026-08-24",
      channels: [
        {
          num: 1,
          role: "movies",
          days: [{ date: "2026-08-24", slots: [{ at: "10:00", slug: "m1" }] }],
        },
      ],
    },
    library,
    config: {
      station: { name: "T", timezone: zone },
      channels: [{ num: 1, name: "M", role: "movies" }],
    },
    nowMs: 0,
  };
}

function libEntry(overrides = {}) {
  return {
    slug: "m1",
    title: "M1",
    kind: "movie",
    runtime_s: 3600,
    hls: "content/m1/index.m3u8",
    ...overrides,
  };
}

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

test("compileSchedule refuses a library entry missing runtime_s", () => {
  const entry = libEntry();
  delete entry.runtime_s;
  // The broken airing is last on its channel: without validation this
  // compiled clean and published `"end": null`.
  assert.throws(
    () => compileSchedule(compileInput([entry])),
    (err) => {
      assert.ok(err instanceof CompileError);
      assert.equal(err.name, "CompileError");
      assert.deepEqual(err.problems, [
        'library entry "m1": runtime_s must be a finite number > 0, not undefined',
      ]);
      return true;
    },
  );
});

test("compileSchedule refuses zero, negative, NaN, and string runtime_s", () => {
  for (const bad of [0, -600, NaN, "3600"]) {
    assert.throws(
      () => compileSchedule(compileInput([libEntry({ runtime_s: bad })])),
      (err) => {
        assert.ok(
          err instanceof CompileError,
          `runtime_s ${String(bad)}: expected CompileError, got ${err}`,
        );
        assert.ok(
          err.problems.some((p) =>
            p.includes(
              'library entry "m1": runtime_s must be a finite number > 0',
            ),
          ),
          `runtime_s ${String(bad)}:\n  ${err.problems.join("\n  ")}`,
        );
        return true;
      },
    );
  }
});

test("a broken airing with a successor refuses instead of crashing the packer", () => {
  // Without validation the NaN end reached packGap as a gap bound and
  // threw a raw TypeError past callers' typed refusal handling.
  const broken = libEntry();
  delete broken.runtime_s;
  const input = compileInput([broken, libEntry({ slug: "m2", title: "M2" })]);
  input.programming.channels[0].days[0].slots.push({
    at: "10:20",
    slug: "m2",
  });
  assert.throws(
    () => compileSchedule(input),
    (err) => {
      assert.ok(err instanceof CompileError, `expected CompileError, got ${err}`);
      return true;
    },
  );
});

test("every defective library entry lands in one refusal", () => {
  // m2 and the slugless entry are never programmed anywhere: the whole
  // library is a stable boundary, so unused entries are checked too.
  const first = libEntry();
  delete first.runtime_s;
  const library = [
    first,
    libEntry({ slug: "m2", title: "", runtime_s: -5 }),
    libEntry({ slug: "", hls: "" }),
  ];
  assert.throws(
    () => compileSchedule(compileInput(library)),
    (err) => {
      assert.ok(err instanceof CompileError);
      assert.deepEqual(err.problems, [
        'library entry "m1": runtime_s must be a finite number > 0, not undefined',
        'library entry "m2": title must be a non-empty string',
        'library entry "m2": runtime_s must be a finite number > 0, not -5',
        "library entry 2: slug must be a non-empty string",
        "library entry 2: hls must be a non-empty string",
      ]);
      return true;
    },
  );
});

test("control: the valid fixture library still compiles", () => {
  const schedule = compileSchedule({
    programming: fixture("programming.small.json"),
    library: fixture("library.small.json"),
    config: fixture("config.small.json"),
    nowMs: 0,
  });
  assert.equal(schedule.channels.length, 3);
});
