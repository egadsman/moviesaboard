// Interstitial packer: fills a schedule gap with randomly chosen
// interstitials/clips from the library, deterministically for a given seed.
// Pure — no I/O, no clock reads. All times are absolute epoch milliseconds.

/**
 * mulberry32 — tiny deterministic PRNG.
 *
 * @param {number} seed integer seed
 * @returns {() => number} generator of floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PACKABLE_KINDS = new Set(["interstitial", "clip"]);

// A pool entry is usable if it has a slug and a positive finite runtime and
// is of a packable kind (library.json entries of kind interstitial|clip).
function usable(entry) {
  return (
    entry != null &&
    typeof entry.slug === "string" &&
    entry.slug.length > 0 &&
    PACKABLE_KINDS.has(entry.kind) &&
    Number.isFinite(entry.runtime_s) &&
    entry.runtime_s > 0
  );
}

/**
 * Pack a gap [gapStartMs, gapEndMs) with items from the pool.
 *
 * Placements are contiguous from gapStartMs and never exceed gapEndMs.
 * Items are chosen uniformly at random (mulberry32 seeded with `seed`)
 * among the items that still fit; the immediately previous slug is not
 * repeated when another fitting item exists. Packing stops as soon as no
 * item fits — any trailing remainder stays empty.
 *
 * @param {object} args
 * @param {number} args.gapStartMs gap start, epoch ms
 * @param {number} args.gapEndMs gap end, epoch ms
 * @param {Array<object>} args.pool library entries (interstitial|clip)
 * @param {number} args.seed integer PRNG seed
 * @returns {Array<{slug: string, start: number, end: number}>}
 */
export function packGap({ gapStartMs, gapEndMs, pool, seed }) {
  if (!Number.isFinite(gapStartMs) || !Number.isFinite(gapEndMs)) {
    throw new TypeError("gapStartMs and gapEndMs must be finite numbers");
  }
  if (gapEndMs < gapStartMs) {
    throw new TypeError(
      `gapEndMs (${gapEndMs}) must not precede gapStartMs (${gapStartMs})`,
    );
  }

  const items = Array.isArray(pool) ? pool.filter(usable) : [];
  if (items.length === 0) return [];

  const rand = mulberry32(seed);
  const placements = [];
  let cursor = gapStartMs;
  let prevSlug = null;

  for (;;) {
    const remaining = gapEndMs - cursor;
    let fits = items.filter((e) => e.runtime_s * 1000 <= remaining);
    if (fits.length === 0) break;

    const notPrev = fits.filter((e) => e.slug !== prevSlug);
    if (notPrev.length > 0) fits = notPrev;

    const pick = fits[Math.floor(rand() * fits.length)];
    const end = cursor + pick.runtime_s * 1000;
    placements.push({ slug: pick.slug, start: cursor, end });
    cursor = end;
    prevSlug = pick.slug;
  }

  return placements;
}
