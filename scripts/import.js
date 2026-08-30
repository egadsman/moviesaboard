// Build library.json from an existing content/ directory of encoded HLS
// titles — the frozen on-disk layout (docs/contracts.md): one
// content/<slug>/ per title holding index.m3u8 + seg-*.ts + meta.json.
// Understands both the current meta shape and the legacy one
// ({ slug, title, duration_s }); everything derivable comes from the slug
// conventions. Existing libraries migrate with zero re-encoding.
//
//   node scripts/import.js <contentDir> [--out <file>] [--dry-run]
//
// Titles missing meta.json or index.m3u8, or with unusable meta, are
// skipped and reported. The output is written atomically. Exits 1 when
// nothing usable is found.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { libraryEntryFromMeta, ImportError } from "@moviesaboard/core";

/**
 * Scan a content directory into { library, skipped }.
 * `skipped` is [{ slug, reason }] for every directory that made no entry.
 */
export async function buildLibraryFromContent(contentDir) {
  const library = [];
  const skipped = [];
  let names;
  try {
    names = (await fs.readdir(contentDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (err) {
    throw new Error(`cannot read ${contentDir}: ${err.message}`);
  }
  for (const slug of names) {
    const dir = path.join(contentDir, slug);
    try {
      await fs.access(path.join(dir, "index.m3u8"));
    } catch {
      skipped.push({ slug, reason: "no index.m3u8" });
      continue;
    }
    let meta;
    let mtimeIso;
    try {
      const metaPath = path.join(dir, "meta.json");
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      mtimeIso = (await fs.stat(metaPath)).mtime.toISOString();
    } catch (err) {
      skipped.push({ slug, reason: `meta.json unreadable: ${err.message}` });
      continue;
    }
    try {
      library.push(
        libraryEntryFromMeta({ slug, meta, encodedAtIso: mtimeIso }),
      );
    } catch (err) {
      if (err instanceof ImportError) {
        skipped.push({ slug, reason: err.problems.join("; ") });
        continue;
      }
      throw err;
    }
  }
  return { library, skipped };
}

function summarize(library) {
  const byKind = {};
  for (const e of library) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const series = new Set(
    library.filter((e) => e.kind === "episode").map((e) => e.series),
  );
  return { byKind, seriesCount: series.size };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : "library.json";
  const contentDir = args.find((a) => !a.startsWith("--") && a !== out);
  if (!contentDir) {
    console.error(
      "usage: node scripts/import.js <contentDir> [--out <file>] [--dry-run]",
    );
    process.exit(2);
  }

  const { library, skipped } = await buildLibraryFromContent(contentDir);
  const { byKind, seriesCount } = summarize(library);
  console.log(
    `[import] ${library.length} entries ` +
      `(${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")}` +
      `; ${seriesCount} series), ${skipped.length} skipped`,
  );
  for (const s of skipped) console.log(`  skip ${s.slug}: ${s.reason}`);
  if (library.length === 0) {
    console.error("[import] nothing usable — refusing to write");
    process.exit(1);
  }
  if (dryRun) {
    console.log("[import] dry run — sample entries:");
    for (const e of library.slice(0, 3)) {
      console.log(`  ${JSON.stringify(e)}`);
    }
    return;
  }
  await fs.writeFile(`${out}.tmp`, `${JSON.stringify(library, null, 2)}\n`);
  await fs.rename(`${out}.tmp`, out);
  console.log(`[import] wrote ${out}`);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(`[import] ${err.message}`);
    process.exit(1);
  });
}
