// Vote tally for the vote channel (docs/contracts.md: the open ballot
// and vote history join state/ when stationd lands, and stationd will
// own that I/O). Pure module: no clock reads, no I/O — callers pass the
// ballot, the raw vote log, the library, and a seed, and get
// deterministic data back.

// mulberry32 PRNG — small, fast, deterministic for a given 32-bit seed.
// Embedded locally on purpose; core modules do not import each other's
// internals.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Map an arbitrary seed to a 32-bit integer. Finite numbers are used
// directly; anything else is FNV-1a hashed from its string form, so string
// seeds (e.g. an ISO date) are stable across runs and platforms.
function seedToUint32(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Locale-independent slug ordering (plain code-unit comparison, never
// localeCompare, which depends on the host environment).
function bySlugAscending(a, b) {
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

/**
 * Tally a vote log against a ballot.
 *
 * @param {object} input
 * @param {string[]} input.ballot ballot slugs
 * @param {{voter: string, slug: string, at: number}[]} input.votes raw vote
 *   log in arrival order; `at` is epoch milliseconds
 * @returns {{counts: {slug: string, votes: number}[], winner: string|null}}
 *   `counts` has one entry per ballot slug, ranked votes descending, ties
 *   broken by slug ascending. `winner` is `counts[0].slug` when it has at
 *   least one vote, else null.
 *
 * One vote per voter: the latest by `at` wins; when the same voter has two
 * votes with the same `at`, the later array position wins. Votes for slugs
 * not on the ballot are ignored entirely — they neither count nor displace
 * a voter's earlier on-ballot vote.
 */
export function tally({ ballot, votes }) {
  const onBallot = new Set(ballot);

  // voter -> { slug, at } for that voter's effective vote so far.
  const effective = new Map();
  for (const vote of votes) {
    if (!onBallot.has(vote.slug)) continue;
    const prev = effective.get(vote.voter);
    if (prev === undefined || vote.at >= prev.at) {
      effective.set(vote.voter, { slug: vote.slug, at: vote.at });
    }
  }

  const perSlug = new Map();
  for (const slug of onBallot) perSlug.set(slug, 0);
  for (const { slug } of effective.values()) {
    perSlug.set(slug, perSlug.get(slug) + 1);
  }

  const counts = [...perSlug]
    .map(([slug, count]) => ({ slug, votes: count }))
    .sort((a, b) => b.votes - a.votes || bySlugAscending(a, b));

  const winner =
    counts.length > 0 && counts[0].votes > 0 ? counts[0].slug : null;
  return { counts, winner };
}

/**
 * Pick the slugs for a new ballot.
 *
 * @param {object} input
 * @param {object[]} input.library library.json entries (contracts.md §1)
 * @param {number} input.benchSize maximum ballot size
 * @param {string[]} [input.history] slugs to exclude (recently aired
 *   winners)
 * @param {number|string} input.seed shuffle seed; the same seed over the
 *   same library and history always yields the same ballot
 * @returns {string[]} up to `benchSize` movie slugs
 *
 * Eligible entries are movies whose slug is not in `history`. They are
 * shuffled deterministically (Fisher–Yates over a mulberry32 stream seeded
 * by `seed`) and the first `benchSize` are returned.
 */
export function openBallot({ library, benchSize, history = [], seed }) {
  const aired = new Set(history);
  const eligible = [];
  for (const entry of library) {
    if (entry.kind === "movie" && !aired.has(entry.slug)) {
      eligible.push(entry.slug);
    }
  }

  const next = mulberry32(seedToUint32(seed));
  for (let i = eligible.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
  }

  return eligible.slice(0, benchSize);
}
