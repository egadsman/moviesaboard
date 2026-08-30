import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileSchedule, CompileError, MAX_PACK_GAP_MS } from "../lib/compile.js";

const FIXTURES = new URL("./fixtures/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

// nowMs used by the golden fixture: 2026-08-24T10:00:00Z (05:00 CDT).
const NOW_MS = 1_787_565_600_000;

// Vote placements merged into the golden compile (channel 5). Starts are
// 2026-08-26 19:00 and 20:56 CDT (UTC-5): the first ends 86 min later at
// 20:26, leaving an exactly-30-minute gap — the packable maximum.
const GOLDEN_VOTES = [
  { slug: "signal-hill", startMs: 1_787_788_800_000 },
  { slug: "cape-morning", startMs: 1_787_795_760_000 },
];

function goldenInput() {
  return {
    programming: fixture("programming.small.json"),
    library: fixture("library.small.json"),
    config: fixture("config.small.json"),
    votePlacements: GOLDEN_VOTES.map((p) => ({ ...p })),
    nowMs: NOW_MS,
  };
}

// Minimal hand-built input for the refusal tests. Every piece is freshly
// constructed so tests can mutate without cross-talk.
function makeLibrary() {
  return [
    {
      slug: "movie-a",
      title: "Movie A",
      kind: "movie",
      runtime_s: 3600,
      hls: "content/movie-a/index.m3u8",
      source: "directory:/m/a.mkv",
      encoded_at: "2026-08-01T00:00:00Z",
      profile: "720p-crf23",
    },
    {
      slug: "movie-b",
      title: "Movie B",
      kind: "movie",
      runtime_s: 3600,
      hls: "content/movie-b/index.m3u8",
      source: "directory:/m/b.mkv",
      encoded_at: "2026-08-01T00:00:00Z",
      profile: "720p-crf23",
    },
    {
      slug: "ad-x",
      title: "Ad X",
      kind: "interstitial",
      runtime_s: 600,
      hls: "content/ad-x/index.m3u8",
      source: "directory:/m/x.mp4",
      encoded_at: "2026-08-01T00:00:00Z",
      profile: "720p-crf23",
    },
  ];
}

function makeInput(overrides = {}) {
  return {
    programming: {
      version: 1,
      week_start: "2026-08-24",
      channels: [
        {
          num: 1,
          role: "movies",
          days: [
            {
              date: "2026-08-24",
              slots: [
                { at: "10:00", slug: "movie-a" },
                { at: "12:00", slug: "movie-b" },
              ],
            },
          ],
        },
      ],
    },
    library: makeLibrary(),
    config: {
      station: { name: "Test", timezone: "America/Chicago" },
      channels: [
        { num: 1, name: "Movies", role: "movies" },
        { num: 5, name: "Requests", role: "vote" },
      ],
    },
    votePlacements: [],
    nowMs: NOW_MS,
    ...overrides,
  };
}

function assertRefuses(args, ...patterns) {
  assert.throws(
    () => compileSchedule(args),
    (err) => {
      assert.ok(err instanceof CompileError, `expected CompileError, got ${err}`);
      assert.equal(err.name, "CompileError");
      assert.ok(Array.isArray(err.problems) && err.problems.length > 0);
      for (const re of patterns) {
        assert.ok(
          err.problems.some((p) => re.test(p)),
          `no problem matching ${re} in:\n  ${err.problems.join("\n  ")}`,
        );
      }
      return true;
    },
  );
}

// ---------------------------------------------------------------- golden

test("golden: compiles the small fixture station exactly", () => {
  const schedule = compileSchedule(goldenInput());
  assert.deepEqual(schedule, fixture("schedule.golden.json"));
});

test("golden compile is deterministic", () => {
  assert.deepEqual(compileSchedule(goldenInput()), compileSchedule(goldenInput()));
});

test("golden structure: sorted, contiguous around packed gaps, off-air kept", () => {
  const schedule = compileSchedule(goldenInput());

  assert.equal(schedule.generated, NOW_MS);
  assert.deepEqual(schedule.station, {
    name: "SS Fixture",
    timezone: "America/Chicago",
  });

  // Channels sorted by num, airings by start, no overlaps anywhere.
  assert.deepEqual(
    schedule.channels.map((c) => c.num),
    [1, 2, 5],
  );
  const bySlug = new Map(fixture("library.small.json").map((e) => [e.slug, e]));
  for (const ch of schedule.channels) {
    let prevEnd = -Infinity;
    for (const a of ch.airings) {
      assert.ok(a.start >= prevEnd, `${ch.num}: airings overlap or unsorted`);
      const entry = bySlug.get(a.slug);
      assert.equal(a.title, entry.title);
      assert.equal(a.src, entry.hls);
      assert.equal(a.end, a.start + entry.runtime_s * 1000);
      assert.equal(a.live, false);
      prevEnd = a.end;
    }
  }

  // Channel 1: the 5-minute gap (21:55-22:00 CDT) is packed shut — the
  // features plus fill are fully contiguous.
  const ch1 = schedule.channels[0];
  for (let i = 1; i < ch1.airings.length; i++) {
    assert.equal(ch1.airings[i].start, ch1.airings[i - 1].end);
  }
  assert.equal(ch1.airings[0].slug, "harbor-fog");
  assert.equal(ch1.airings.at(-1).slug, "cape-morning");

  // Channel 2: the 65-minute gap before beach-patrol-03 stays empty —
  // off-air is legal. beach-patrol-03 starts 2026-08-25 20:00 CDT.
  const ch2 = schedule.channels[1];
  const ep3 = ch2.airings.at(-1);
  assert.equal(ep3.slug, "beach-patrol-03");
  assert.ok(ep3.start - ch2.airings.at(-2).end > MAX_PACK_GAP_MS);

  // Channel 5 (vote): built purely from placements; its exactly-30-minute
  // gap is packed shut up to the second placement.
  const ch5 = schedule.channels[2];
  assert.equal(ch5.airings[0].slug, "signal-hill");
  assert.equal(ch5.airings[0].start, GOLDEN_VOTES[0].startMs);
  assert.equal(ch5.airings.at(-1).slug, "cape-morning");
  assert.equal(ch5.airings.at(-1).start, GOLDEN_VOTES[1].startMs);
  for (let i = 1; i < ch5.airings.length; i++) {
    assert.equal(ch5.airings[i].start, ch5.airings[i - 1].end);
  }
  for (const a of ch5.airings.slice(1, -1)) {
    assert.ok(["interstitial", "clip"].includes(bySlug.get(a.slug).kind));
  }
});

// ------------------------------------------------------------------ DST

test("DST fall-back day: 2026-11-01 slots resolve to hand-derived epochs", () => {
  const input = makeInput();
  input.programming.channels[0].days = [
    {
      date: "2026-11-01",
      slots: [
        { at: "01:30", slug: "movie-a" },
        { at: "12:00", slug: "movie-b" },
      ],
    },
  ];
  const schedule = compileSchedule(input);
  const airings = schedule.channels[0].airings;

  // 01:30 is ambiguous on the US fall-back day; the contract picks the
  // EARLIER instant, still CDT (UTC-5): 2026-11-01T06:30:00Z.
  assert.equal(airings[0].start, Date.UTC(2026, 10, 1, 6, 30, 0));
  assert.equal(airings[0].start, 1_793_514_600_000);
  assert.equal(airings[0].end, airings[0].start + 3600 * 1000);

  // 12:00 is after the shift, CST (UTC-6): 2026-11-01T18:00:00Z. The wall
  // gap 02:30-12:00 spans 9.5h but the epoch gap is 10.5h (25-hour day).
  assert.equal(airings[1].start, Date.UTC(2026, 10, 1, 18, 0, 0));
  assert.equal(airings[1].start, 1_793_556_000_000);
  assert.equal(airings[1].start - airings[0].end, 10.5 * 3600 * 1000);
});

test("DST fall-back day: a post-shift morning slot lands on CST", () => {
  const input = makeInput();
  input.programming.channels[0].days = [
    { date: "2026-11-01", slots: [{ at: "03:00", slug: "movie-a" }] },
  ];
  const schedule = compileSchedule(input);
  // 03:00 CST (UTC-6) = 2026-11-01T09:00:00Z.
  assert.equal(schedule.channels[0].airings[0].start, 1_793_523_600_000);
});

// ----------------------------------------------------------- gap packing

test("an exactly-30-minute gap is packed; fill starts at the gap start", () => {
  const input = makeInput();
  // movie-a 10:00-11:00, movie-b 11:30: gap is exactly MAX_PACK_GAP_MS.
  input.programming.channels[0].days[0].slots[1].at = "11:30";
  const airings = compileSchedule(input).channels[0].airings;
  // 600s ad packs the 1800s gap exactly: a, ad-x, ad-x, ad-x, b.
  assert.deepEqual(
    airings.map((a) => a.slug),
    ["movie-a", "ad-x", "ad-x", "ad-x", "movie-b"],
  );
  for (let i = 1; i < airings.length; i++) {
    assert.equal(airings[i].start, airings[i - 1].end);
  }
});

test("a gap over 30 minutes stays empty", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots[1].at = "11:31";
  const airings = compileSchedule(input).channels[0].airings;
  assert.deepEqual(
    airings.map((a) => a.slug),
    ["movie-a", "movie-b"],
  );
});

test("back-to-back airings get no fill", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots[1].at = "11:00";
  const airings = compileSchedule(input).channels[0].airings;
  assert.deepEqual(
    airings.map((a) => a.slug),
    ["movie-a", "movie-b"],
  );
});

test("packing never runs before the first or after the last airing", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots = [
    { at: "10:00", slug: "movie-a" },
  ];
  const airings = compileSchedule(input).channels[0].airings;
  assert.deepEqual(
    airings.map((a) => a.slug),
    ["movie-a"],
  );
});

// ----------------------------------------------------------- vote channel

test("vote placements arrive unsorted, airings come out sorted", () => {
  const input = makeInput({
    votePlacements: [
      { slug: "movie-b", startMs: NOW_MS + 100 * 3600 * 1000 },
      { slug: "movie-a", startMs: NOW_MS + 90 * 3600 * 1000 },
    ],
  });
  const ch5 = compileSchedule(input).channels.find((c) => c.num === 5);
  assert.deepEqual(
    ch5.airings.map((a) => a.slug),
    ["movie-a", "movie-b"],
  );
});

test("omitted votePlacements default to an empty vote channel", () => {
  const input = makeInput();
  delete input.votePlacements;
  const ch5 = compileSchedule(input).channels.find((c) => c.num === 5);
  assert.deepEqual(ch5.airings, []);
});

// -------------------------------------------------------------- refusals

test("refuses a programming slug missing from the library", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots[0].slug = "no-such-film";
  assertRefuses(input, /channel 1 .*"no-such-film" not in library/);
});

test("refuses a vote placement slug missing from the library", () => {
  const input = makeInput({
    votePlacements: [{ slug: "no-such-film", startMs: NOW_MS }],
  });
  assertRefuses(input, /channel 5: vote placement slug "no-such-film" not in library/);
});

test("refuses slots out of order within a day", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots = [
    { at: "12:00", slug: "movie-a" },
    { at: "10:00", slug: "movie-b" },
  ];
  assertRefuses(input, /channel 1 2026-08-24: slots out of order \("10:00" after "12:00"\)/);
});

test("refuses overlapping airings within a day", () => {
  const input = makeInput();
  // movie-a 10:00-11:00 overlaps movie-b starting 10:30.
  input.programming.channels[0].days[0].slots[1].at = "10:30";
  assertRefuses(input, /channel 1: overlapping airings "movie-a" .* "movie-b"/);
});

test("refuses overlaps that only appear after resolution, across days", () => {
  const input = makeInput();
  input.programming.channels[0].days = [
    { date: "2026-08-24", slots: [{ at: "23:30", slug: "movie-a" }] },
    { date: "2026-08-25", slots: [{ at: "00:00", slug: "movie-b" }] },
  ];
  assertRefuses(input, /channel 1: overlapping airings "movie-a" .* "movie-b"/);
});

test("refuses overlapping vote placements", () => {
  const input = makeInput({
    votePlacements: [
      { slug: "movie-a", startMs: NOW_MS },
      { slug: "movie-b", startMs: NOW_MS + 1800 * 1000 },
    ],
  });
  assertRefuses(input, /channel 5: overlapping airings "movie-a" .* "movie-b"/);
});

test("refuses a malformed date", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].date = "2026-02-30";
  assertRefuses(input, /channel 1: malformed date "2026-02-30"/);
});

test("refuses a malformed at", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots[0].at = "25:00";
  assertRefuses(input, /channel 1 2026-08-24: malformed at "25:00"/);
});

test("refuses a missing programming channel for a non-vote config channel", () => {
  const input = makeInput();
  input.config.channels.push({ num: 2, name: "Series", role: "series-grid" });
  assertRefuses(input, /channel 2 \(role series-grid\): missing programming channel/);
});

test("refuses an unknown role", () => {
  const input = makeInput();
  input.config.channels.push({ num: 3, name: "Shop", role: "shopping" });
  assertRefuses(input, /channel 3: unknown role "shopping"/);
});

test("refuses a duplicate channel num", () => {
  const input = makeInput();
  input.config.channels.push({ num: 1, name: "Movies Again", role: "movies" });
  assertRefuses(input, /duplicate channel num 1 in config/);
});

test("refuses a vote channel that appears in programming", () => {
  const input = makeInput();
  input.programming.channels.push({
    num: 5,
    role: "movies",
    days: [{ date: "2026-08-24", slots: [{ at: "09:00", slug: "movie-a" }] }],
  });
  assertRefuses(input, /channel 5 \(role vote\): must not appear in programming/);
});

test("refuses a programming channel that is not in config", () => {
  const input = makeInput();
  input.programming.channels.push({ num: 9, role: "movies", days: [] });
  assertRefuses(input, /programming channel 9 not in config channels/);
});

test("collects every problem before refusing — never a partial schedule", () => {
  const input = makeInput();
  input.programming.channels[0].days[0].slots[0].slug = "no-such-film";
  input.config.channels.push({ num: 1, name: "Dup", role: "movies" });
  input.config.channels.push({ num: 3, name: "Shop", role: "shopping" });
  assertRefuses(
    input,
    /"no-such-film" not in library/,
    /duplicate channel num 1 in config/,
    /channel 3: unknown role "shopping"/,
  );
  let threw = false;
  try {
    compileSchedule(input);
  } catch (err) {
    threw = true;
    assert.ok(err.problems.length >= 3);
  }
  assert.ok(threw);
});
