import test from "node:test";
import assert from "node:assert/strict";
import { ImportError, libraryEntryFromMeta } from "../lib/import.js";

test("old-shape episode meta: kind/series/episode derived from name-NN", () => {
  const entry = libraryEntryFromMeta({
    slug: "starline-05",
    meta: { slug: "starline-05", title: "Starline E5", duration_s: 1441.73 },
    encodedAtIso: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(entry, {
    slug: "starline-05",
    title: "Starline E5",
    kind: "episode",
    runtime_s: 1442,
    hls: "content/starline-05/index.m3u8",
    source: "import",
    encoded_at: "2026-08-01T00:00:00.000Z",
    profile: "imported",
    series: "starline",
    season: 1,
    episode: 5,
  });
});

test("multi-hyphen series slug parses: rail-and-river-02", () => {
  const e = libraryEntryFromMeta({
    slug: "rail-and-river-02",
    meta: { duration_s: 1320.4 },
  });
  assert.equal(e.kind, "episode");
  assert.equal(e.series, "rail-and-river");
  assert.equal(e.episode, 2);
});

test("ad-* and clip-* slugs map to interstitial and clip", () => {
  assert.equal(
    libraryEntryFromMeta({ slug: "ad-x", meta: { duration_s: 15 } }).kind,
    "interstitial",
  );
  assert.equal(
    libraryEntryFromMeta({ slug: "clip-y", meta: { duration_s: 40 } }).kind,
    "clip",
  );
});

test("sub-second legacy duration_s clamps to runtime_s 1, never 0", () => {
  const e = libraryEntryFromMeta({
    slug: "clip-blip",
    meta: { duration_s: 0.4 },
  });
  assert.equal(e.runtime_s, 1);
});

test("plain slug is a movie; 4-digit year suffix is NOT an episode", () => {
  assert.equal(
    libraryEntryFromMeta({ slug: "voidliner", meta: { duration_s: 6000 } }).kind,
    "movie",
  );
  assert.equal(
    libraryEntryFromMeta({
      slug: "neon-harbor-2049",
      meta: { duration_s: 9000 },
    }).kind,
    "movie",
  );
});

test("current-shape meta passes through untouched fields", () => {
  const meta = {
    slug: "m1",
    title: "M1",
    kind: "movie",
    runtime_s: 100,
    source: "demo",
    encoded_at: "2026-01-01T00:00:00.000Z",
    profile: "demo-360p",
  };
  const e = libraryEntryFromMeta({ slug: "m1", meta });
  assert.equal(e.runtime_s, 100);
  assert.equal(e.source, "demo");
  assert.equal(e.profile, "demo-360p");
  assert.equal(e.encoded_at, "2026-01-01T00:00:00.000Z");
});

test("explicit kind overrides the slug convention", () => {
  const e = libraryEntryFromMeta({
    slug: "quay-11",
    meta: { kind: "movie", duration_s: 6000 },
  });
  assert.equal(e.kind, "movie");
  assert.equal(e.series, undefined);
});

test("refusals: no runtime, slug mismatch", () => {
  assert.throws(
    () => libraryEntryFromMeta({ slug: "x", meta: { title: "X" } }),
    (err) => err instanceof ImportError &&
      err.problems.some((p) => p.includes("runtime")),
  );
  assert.throws(
    () =>
      libraryEntryFromMeta({
        slug: "x",
        meta: { slug: "y", duration_s: 10 },
      }),
    (err) => err instanceof ImportError &&
      err.problems.some((p) => p.includes("does not match")),
  );
});
