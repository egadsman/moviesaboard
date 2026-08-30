import { test } from "node:test";
import assert from "node:assert/strict";
import { packGap, mulberry32 } from "../lib/pack.js";

const T0 = 1_700_000_000_000;

const POOL = [
  { slug: "ad-cola", kind: "interstitial", runtime_s: 30 },
  { slug: "ad-shoes", kind: "interstitial", runtime_s: 45 },
  { slug: "clip-cat", kind: "clip", runtime_s: 60 },
];

function pack(overrides = {}) {
  return packGap({
    gapStartMs: T0,
    gapEndMs: T0 + 180_000,
    pool: POOL,
    seed: 42,
    ...overrides,
  });
}

test("mulberry32 is deterministic and yields floats in [0, 1)", () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test("same seed produces the identical packing", () => {
  assert.deepEqual(pack(), pack());
});

test("different seeds can produce different packings", () => {
  assert.notDeepEqual(pack({ seed: 1 }), pack({ seed: 2 }));
});

test("golden: seed 42, 3-item pool, 180s gap", () => {
  assert.deepEqual(pack(), [
    { slug: "ad-shoes", start: T0, end: T0 + 45_000 },
    { slug: "ad-cola", start: T0 + 45_000, end: T0 + 75_000 },
    { slug: "clip-cat", start: T0 + 75_000, end: T0 + 135_000 },
    { slug: "ad-shoes", start: T0 + 135_000, end: T0 + 180_000 },
  ]);
});

test("placements are contiguous from gapStartMs and never overflow", () => {
  for (let seed = 0; seed < 50; seed++) {
    const gapEndMs = T0 + 200_000; // not an exact multiple of any runtime
    const out = pack({ gapEndMs, seed });
    assert.ok(out.length > 0);
    let cursor = T0;
    for (const p of out) {
      assert.equal(p.start, cursor);
      assert.ok(p.end > p.start);
      cursor = p.end;
    }
    assert.ok(cursor <= gapEndMs);
    // Packing stopped only because nothing fits in the remainder.
    const shortest = Math.min(...POOL.map((e) => e.runtime_s * 1000));
    assert.ok(gapEndMs - cursor < shortest);
  }
});

test("no immediate repeats when another item fits", () => {
  for (let seed = 0; seed < 50; seed++) {
    const gapEndMs = T0 + 600_000;
    const out = pack({ gapEndMs, seed });
    for (let i = 1; i < out.length; i++) {
      if (out[i].slug !== out[i - 1].slug) continue;
      // A repeat is only legal when nothing else fit at that point.
      const remaining = gapEndMs - out[i].start;
      const alternatives = POOL.filter(
        (e) => e.slug !== out[i - 1].slug && e.runtime_s * 1000 <= remaining,
      );
      assert.deepEqual(alternatives, []);
    }
  }
});

test("repeats the previous slug when it is the only item that fits", () => {
  const pool = [{ slug: "ad-solo", kind: "interstitial", runtime_s: 10 }];
  const out = pack({ gapEndMs: T0 + 30_000, pool });
  assert.deepEqual(
    out.map((p) => p.slug),
    ["ad-solo", "ad-solo", "ad-solo"],
  );
});

test("empty pool returns []", () => {
  assert.deepEqual(pack({ pool: [] }), []);
});

test("unusable pool entries are ignored", () => {
  const pool = [
    { slug: "feature-1", kind: "movie", runtime_s: 5400 },
    { slug: "ad-broken", kind: "interstitial", runtime_s: 0 },
    { slug: "", kind: "clip", runtime_s: 15 },
    { kind: "clip", runtime_s: 15 },
    null,
  ];
  assert.deepEqual(pack({ pool }), []);
});

test("zero-length gap returns []", () => {
  assert.deepEqual(pack({ gapEndMs: T0 }), []);
});

test("gap shorter than every item returns []", () => {
  assert.deepEqual(pack({ gapEndMs: T0 + 1000 }), []);
});

test("throws TypeError when gapEndMs precedes gapStartMs", () => {
  assert.throws(() => pack({ gapEndMs: T0 - 1 }), TypeError);
});

test("throws TypeError on non-finite bounds", () => {
  assert.throws(() => pack({ gapEndMs: NaN }), TypeError);
  assert.throws(() => pack({ gapStartMs: Infinity }), TypeError);
});
