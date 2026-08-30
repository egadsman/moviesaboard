import { test } from "node:test";
import assert from "node:assert/strict";
import { tally, openBallot } from "../lib/vote.js";

// Minimal library.json fixture (docs/contracts.md §1).
function movie(slug) {
  return {
    slug,
    title: slug,
    kind: "movie",
    runtime_s: 5400,
    hls: `content/${slug}/index.m3u8`,
    source: "fixture",
    encoded_at: "2026-08-01T00:00:00Z",
    profile: "720p",
  };
}

const library = [
  movie("alpha"),
  movie("bravo"),
  movie("charlie"),
  movie("delta"),
  movie("echo"),
  { ...movie("nature-01"), kind: "episode", series: "nature", season: 1, episode: 1 },
  { ...movie("ad-bumper"), kind: "interstitial" },
];

test("tally: a voter's latest vote replaces their earlier one", () => {
  const { counts, winner } = tally({
    ballot: ["alpha", "bravo"],
    votes: [
      { voter: "v1", slug: "alpha", at: 1000 },
      { voter: "v1", slug: "bravo", at: 2000 },
    ],
  });
  assert.deepEqual(counts, [
    { slug: "bravo", votes: 1 },
    { slug: "alpha", votes: 0 },
  ]);
  assert.equal(winner, "bravo");
});

test("tally: latest by at wins even when it arrives earlier in the log", () => {
  const { counts } = tally({
    ballot: ["alpha", "bravo"],
    votes: [
      { voter: "v1", slug: "bravo", at: 2000 },
      { voter: "v1", slug: "alpha", at: 1000 },
    ],
  });
  assert.deepEqual(counts, [
    { slug: "bravo", votes: 1 },
    { slug: "alpha", votes: 0 },
  ]);
});

test("tally: same voter, same at — later array position wins", () => {
  const { counts, winner } = tally({
    ballot: ["alpha", "bravo"],
    votes: [
      { voter: "v1", slug: "alpha", at: 5000 },
      { voter: "v1", slug: "bravo", at: 5000 },
    ],
  });
  assert.deepEqual(counts, [
    { slug: "bravo", votes: 1 },
    { slug: "alpha", votes: 0 },
  ]);
  assert.equal(winner, "bravo");
});

test("tally: off-ballot votes are ignored entirely", () => {
  const { counts, winner } = tally({
    ballot: ["alpha", "bravo"],
    votes: [
      { voter: "v1", slug: "alpha", at: 1000 },
      // Later but off-ballot: neither counts nor displaces v1's alpha vote.
      { voter: "v1", slug: "zulu", at: 2000 },
      { voter: "v2", slug: "zulu", at: 3000 },
    ],
  });
  assert.deepEqual(counts, [
    { slug: "alpha", votes: 1 },
    { slug: "bravo", votes: 0 },
  ]);
  assert.equal(winner, "alpha");
});

test("tally: ranked votes desc, ties broken by slug ascending", () => {
  const { counts, winner } = tally({
    ballot: ["delta", "bravo", "charlie", "alpha"],
    votes: [
      { voter: "v1", slug: "delta", at: 1 },
      { voter: "v2", slug: "bravo", at: 2 },
      { voter: "v3", slug: "charlie", at: 3 },
      { voter: "v4", slug: "charlie", at: 4 },
    ],
  });
  assert.deepEqual(counts, [
    { slug: "charlie", votes: 2 },
    { slug: "bravo", votes: 1 },
    { slug: "delta", votes: 1 },
    { slug: "alpha", votes: 0 },
  ]);
  assert.equal(winner, "charlie");
});

test("tally: winner is null when no ballot slug has votes", () => {
  const zero = tally({ ballot: ["bravo", "alpha"], votes: [] });
  assert.deepEqual(zero.counts, [
    { slug: "alpha", votes: 0 },
    { slug: "bravo", votes: 0 },
  ]);
  assert.equal(zero.winner, null);

  const offBallotOnly = tally({
    ballot: ["alpha"],
    votes: [{ voter: "v1", slug: "zulu", at: 1 }],
  });
  assert.equal(offBallotOnly.winner, null);

  assert.equal(tally({ ballot: [], votes: [] }).winner, null);
});

test("openBallot: only movies, minus history", () => {
  const ballot = openBallot({
    library,
    benchSize: 10,
    history: ["bravo", "delta"],
    seed: 42,
  });
  assert.deepEqual([...ballot].sort(), ["alpha", "charlie", "echo"]);
});

test("openBallot: deterministic for a fixed seed", () => {
  const args = { library, benchSize: 5, history: [], seed: 1234 };
  const first = openBallot(args);
  const second = openBallot(args);
  assert.deepEqual(first, second);
  // A permutation of all five eligible movies.
  assert.deepEqual([...first].sort(), [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
  ]);
});

test("openBallot: caps at benchSize", () => {
  const ballot = openBallot({ library, benchSize: 3, history: [], seed: 7 });
  assert.equal(ballot.length, 3);
  const unique = new Set(ballot);
  assert.equal(unique.size, 3);
  for (const slug of ballot) {
    assert.ok(["alpha", "bravo", "charlie", "delta", "echo"].includes(slug));
  }
});

test("openBallot: benchSize larger than eligible returns all eligible", () => {
  const ballot = openBallot({ library, benchSize: 99, history: [], seed: 7 });
  assert.equal(ballot.length, 5);
});
