// Library-entry mapper for `import`: turns one on-disk meta.json — the
// current contract shape OR the legacy shape ({ slug, title,
// duration_s }) — into a contract library.json entry, deriving the missing
// fields from the frozen slug conventions (docs/contracts.md): `ad-*`
// interstitials, `clip-*` shorts, `name-NN` episodes, anything else a
// movie. Pure: file scanning stays in scripts/import.js.

import { PlanError } from "./plan.js";

const KINDS = new Set(["movie", "episode", "interstitial", "clip"]);
const EPISODE_SLUG = /^(.+)-(\d{2})$/; // exactly two digits: "name-NN"

/** Refusal of one unusable meta.json. Same shape family as CompileError /
 * PlanError: `.problems` lists what is wrong with this title. */
export class ImportError extends PlanError {
  constructor(slug, problems) {
    super(problems.map((p) => `${slug}: ${p}`));
    this.name = "ImportError";
    this.slug = slug;
  }
}

/**
 * Map one title's meta.json to a library entry.
 *
 * @param {object} args
 * @param {string} args.slug  Directory name, `content/<slug>/`.
 * @param {object} args.meta  Parsed meta.json (either shape).
 * @param {string} [args.encodedAtIso]  Fallback encoded_at (usually the
 *   file's mtime) when meta carries none.
 * @returns {object}  A contract library entry.
 * @throws {ImportError} when the meta cannot make a valid entry.
 */
export function libraryEntryFromMeta({ slug, meta, encodedAtIso }) {
  const problems = [];
  if (typeof slug !== "string" || slug === "") {
    throw new ImportError(String(slug), ["missing slug"]);
  }
  if (meta === null || typeof meta !== "object") {
    throw new ImportError(slug, ["meta.json is not an object"]);
  }
  if (typeof meta.slug === "string" && meta.slug !== slug) {
    problems.push(
      `meta slug ${JSON.stringify(meta.slug)} does not match directory`,
    );
  }

  // runtime_s: current shape wins; old shape's float duration_s rounds.
  let runtimeS;
  if (Number.isInteger(meta.runtime_s) && meta.runtime_s > 0) {
    runtimeS = meta.runtime_s;
  } else if (Number.isFinite(meta.duration_s) && meta.duration_s > 0) {
    runtimeS = Math.round(meta.duration_s);
  } else {
    problems.push("no positive runtime_s or duration_s");
  }

  // kind: explicit and valid wins; otherwise the slug conventions.
  let kind = KINDS.has(meta.kind) ? meta.kind : null;
  const em = EPISODE_SLUG.exec(slug);
  if (!kind) {
    if (slug.startsWith("ad-")) kind = "interstitial";
    else if (slug.startsWith("clip-")) kind = "clip";
    else if (em) kind = "episode";
    else kind = "movie";
  }

  if (problems.length > 0) throw new ImportError(slug, problems);

  const entry = {
    slug,
    title: typeof meta.title === "string" && meta.title !== ""
      ? meta.title
      : slug,
    kind,
    runtime_s: runtimeS,
    hls: `content/${slug}/index.m3u8`,
    source: typeof meta.source === "string" ? meta.source : "import",
    encoded_at: typeof meta.encoded_at === "string"
      ? meta.encoded_at
      : (encodedAtIso ?? null),
    profile: typeof meta.profile === "string" ? meta.profile : "imported",
  };
  if (kind === "episode") {
    entry.series = typeof meta.series === "string" && meta.series !== ""
      ? meta.series
      : em
        ? em[1]
        : slug;
    entry.season = Number.isInteger(meta.season) ? meta.season : 1;
    entry.episode = Number.isInteger(meta.episode)
      ? meta.episode
      : em
        ? Number(em[2])
        : 1;
  }
  if (meta.artwork !== undefined) entry.artwork = meta.artwork;
  return entry;
}
