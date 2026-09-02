// Demo fixture generator: synthetic train-themed HLS titles, encoded with
// ffmpeg into demo-dist/content/<slug>/ per the frozen on-disk layout in
// docs/contracts.md (index.m3u8 + seg-*.ts + meta.json). Restart-safe
// per title: one whose meta.json and index.m3u8 already exist is
// skipped; a partial dir (killed before meta.json landed) is wiped and
// re-encoded. Only dirs named in TITLES are ever touched.
//
// Some ffmpeg builds ship without the drawtext filter (no freetype), so the
// title/slug overlay is rendered here as a BMP title card (tiny embedded
// 5x7 pixel font, pure Node, zero dependencies) and composited with the
// core `overlay` filter, which every ffmpeg has.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Found on PATH by default; FFMPEG/FFPROBE env vars override for pinned
// or unusual installs.
export const DEFAULT_FFMPEG = process.env.FFMPEG || "ffmpeg";
export const DEFAULT_FFPROBE = process.env.FFPROBE || "ffprobe";

const WIDTH = 640;
const HEIGHT = 360;
const PROFILE = "demo-360p";

// One entry per synthetic title. `seconds` is the requested length; the
// meta.json runtime_s always comes from the encoded output, not from here.
// `bg` alternates test patterns and `tone` varies the sine frequency so
// flipping channels LOOKS and SOUNDS different.
export const TITLES = [
  { slug: "sunset-express", title: "Sunset Express", kind: "movie",
    seconds: 480, bg: "smptebars", tone: 220 },
  { slug: "iron-junction", title: "Iron Junction", kind: "movie",
    seconds: 495, bg: "testsrc2", tone: 262 },
  { slug: "midnight-local", title: "Midnight Local", kind: "movie",
    seconds: 420, bg: "smptebars", tone: 330 },

  { slug: "railwatch-01", title: "Railwatch S1E1", kind: "episode",
    series: "Railwatch", season: 1, episode: 1,
    seconds: 240, bg: "testsrc2", tone: 392 },
  { slug: "railwatch-02", title: "Railwatch S1E2", kind: "episode",
    series: "Railwatch", season: 1, episode: 2,
    seconds: 240, bg: "smptebars", tone: 440 },
  { slug: "railwatch-03", title: "Railwatch S1E3", kind: "episode",
    series: "Railwatch", season: 1, episode: 3,
    seconds: 240, bg: "testsrc2", tone: 494 },

  { slug: "dining-car-01", title: "Dining Car Confidential S1E1",
    kind: "episode", series: "Dining Car Confidential",
    season: 1, episode: 1, seconds: 240, bg: "smptebars", tone: 523 },
  { slug: "dining-car-02", title: "Dining Car Confidential S1E2",
    kind: "episode", series: "Dining Car Confidential",
    season: 1, episode: 2, seconds: 240, bg: "testsrc2", tone: 587 },
  { slug: "dining-car-03", title: "Dining Car Confidential S1E3",
    kind: "episode", series: "Dining Car Confidential",
    season: 1, episode: 3, seconds: 240, bg: "smptebars", tone: 659 },

  { slug: "ad-station-id", title: "Station Identification",
    kind: "interstitial", seconds: 15, bg: "smptebars", tone: 698 },
  { slug: "ad-snack-car", title: "The Snack Car",
    kind: "interstitial", seconds: 20, bg: "testsrc2", tone: 784 },
  { slug: "ad-quiet-hours", title: "Quiet Hours Ahead",
    kind: "interstitial", seconds: 15, bg: "smptebars", tone: 880 },

  { slug: "clip-scenery", title: "Passing Scenery", kind: "clip",
    seconds: 45, bg: "testsrc2", tone: 147 },
  { slug: "clip-conductor", title: "Ask the Conductor", kind: "clip",
    seconds: 40, bg: "smptebars", tone: 175 },
];

/* ---------------- 5x7 bitmap font ----------------
 * Rows top to bottom, 5 bits each, bit 4 = leftmost pixel. Uppercase
 * only; lowercase input is uppercased before lookup. Unknown chars
 * render as a space. */
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  3: [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "'": [0x04, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

const CELL = 6; // 5 font pixels + 1 spacing

function textWidth(text, scale) {
  return text.length > 0 ? (text.length * CELL - 1) * scale : 0;
}

function fitScale(text, maxWidth, maxScale) {
  const perChar = text.length * CELL - 1;
  const s = Math.floor(maxWidth / Math.max(1, perChar));
  return Math.max(1, Math.min(maxScale, s));
}

// Paint `text` into an RGB framebuffer (row-major, top-down).
function drawText(fb, fbWidth, text, x0, y0, scale, [r, g, b]) {
  const upper = text.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    const glyph = FONT[upper[i]] ?? FONT[" "];
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col += 1) {
        if (!(bits & (1 << (4 - col)))) continue;
        const px = x0 + (i * CELL + col) * scale;
        const py = y0 + row * scale;
        for (let dy = 0; dy < scale; dy += 1) {
          const base = ((py + dy) * fbWidth + px) * 3;
          for (let dx = 0; dx < scale; dx += 1) {
            const o = base + dx * 3;
            fb[o] = r;
            fb[o + 1] = g;
            fb[o + 2] = b;
          }
        }
      }
    }
  }
}

function fillRect(fb, fbWidth, x, y, w, h, [r, g, b]) {
  for (let dy = 0; dy < h; dy += 1) {
    const base = ((y + dy) * fbWidth + x) * 3;
    for (let dx = 0; dx < w; dx += 1) {
      const o = base + dx * 3;
      fb[o] = r;
      fb[o + 1] = g;
      fb[o + 2] = b;
    }
  }
}

// Encode an RGB framebuffer as an uncompressed 24-bit BMP (bottom-up).
function encodeBmp(width, height, fb) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowBytes * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < height; y += 1) {
    const srcRow = height - 1 - y; // BMP stores bottom-up
    let o = 54 + y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const s = (srcRow * width + x) * 3;
      buf[o] = fb[s + 2]; // B
      buf[o + 1] = fb[s + 1]; // G
      buf[o + 2] = fb[s]; // R
      o += 3;
    }
  }
  return buf;
}

/** Render the lower-third style title card for one entry as a BMP. */
export function renderCard({ title, slug }) {
  const pad = 18;
  const gap = 12;
  const accent = 3;
  const titleScale = fitScale(title, WIDTH - 2 * pad, 5);
  const slugScale = Math.min(2, fitScale(slug, WIDTH - 2 * pad, 2));
  const height =
    accent + pad + 7 * titleScale + gap + 7 * slugScale + pad + accent;

  const fb = new Uint8Array(WIDTH * height * 3);
  fillRect(fb, WIDTH, 0, 0, WIDTH, height, [12, 16, 28]);
  fillRect(fb, WIDTH, 0, 0, WIDTH, accent, [255, 176, 32]);
  fillRect(fb, WIDTH, 0, height - accent, WIDTH, accent, [255, 176, 32]);

  const tx = Math.floor((WIDTH - textWidth(title, titleScale)) / 2);
  drawText(fb, WIDTH, title, tx, accent + pad, titleScale, [240, 244, 255]);
  const sx = Math.floor((WIDTH - textWidth(slug, slugScale)) / 2);
  drawText(
    fb,
    WIDTH,
    slug,
    sx,
    accent + pad + 7 * titleScale + gap,
    slugScale,
    [150, 165, 190],
  );
  return encodeBmp(WIDTH, height, fb);
}

/* ---------------- processes ---------------- */

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      reject(
        e.code === "ENOENT"
          ? new Error(
              `${cmd} not found. Install ffmpeg (e.g. \`brew install ` +
                `ffmpeg\`) or point the FFMPEG/FFPROBE env vars at it.`,
            )
          : e,
      );
    });
    child.on("close", (code, signal) => {
      if (code === 0) resolve(out);
      else {
        // code is null when a signal killed the child; say which one.
        const how = signal ? `killed by ${signal}` : `exited ${code}`;
        reject(new Error(`${cmd} ${args.join(" ")} ${how}:\n${err}`));
      }
    });
  });
}

// Encoded duration in whole seconds: ffprobe on the playlist, with a
// fallback that sums the #EXTINF segment durations.
async function encodedRuntimeS(ffprobe, playlistPath) {
  try {
    const out = await run(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      playlistPath,
    ]);
    const dur = Number.parseFloat(out.trim());
    if (Number.isFinite(dur) && dur > 0) return Math.max(1, Math.round(dur));
  } catch {
    // fall through to the playlist parse
  }
  const text = await fs.readFile(playlistPath, "utf8");
  let sum = 0;
  for (const line of text.split("\n")) {
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m) sum += Number.parseFloat(m[1]);
  }
  if (!(sum > 0)) {
    throw new Error(`cannot determine duration of ${playlistPath}`);
  }
  return Math.max(1, Math.round(sum));
}

async function encodeTitle({ entry, distDir, ffmpeg, ffprobe, log }) {
  const titleDir = path.join(distDir, "content", entry.slug);
  const cardsDir = path.join(distDir, ".cards");
  const cardPath = path.join(cardsDir, `${entry.slug}.bmp`);

  await fs.rm(titleDir, { recursive: true, force: true });
  await fs.mkdir(titleDir, { recursive: true });
  await fs.mkdir(cardsDir, { recursive: true });
  await fs.writeFile(cardPath, renderCard(entry));

  const fps = 30;
  const gop = 4 * fps; // keyframe every 4s = one per HLS segment
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `${entry.bg}=size=${WIDTH}x${HEIGHT}:rate=${fps}`,
    "-f", "lavfi", "-i", `sine=frequency=${entry.tone}:sample_rate=48000`,
    "-i", cardPath,
    "-filter_complex", "[0:v][2:v]overlay=(W-w)/2:(H-h)/2[v]",
    "-map", "[v]", "-map", "1:a",
    "-t", String(entry.seconds),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", String(gop), "-keyint_min", String(gop), "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "96k",
    "-f", "hls", "-hls_time", "4",
    "-hls_playlist_type", "vod", "-hls_list_size", "0",
    "-hls_segment_filename", "seg-%04d.ts",
    "index.m3u8",
  ];
  // cwd = the title dir so the playlist references bare seg-*.ts names.
  await run(ffmpeg, args, { cwd: titleDir });
  await fs.rm(cardPath, { force: true });

  const playlistPath = path.join(titleDir, "index.m3u8");
  const runtimeS = await encodedRuntimeS(ffprobe, playlistPath);
  const stat = await fs.stat(playlistPath);

  const meta = {
    slug: entry.slug,
    title: entry.title,
    kind: entry.kind,
    ...(entry.series !== undefined && {
      series: entry.series,
      season: entry.season,
      episode: entry.episode,
    }),
    runtime_s: runtimeS,
    hls: `content/${entry.slug}/index.m3u8`,
    source: "demo",
    encoded_at: stat.mtime.toISOString(),
    profile: PROFILE,
  };
  // meta.json is written LAST and atomically (tmp + rename): its presence
  // marks the title as complete, which is what makes generation
  // restart-safe even through a kill mid-write.
  const metaPath = path.join(titleDir, "meta.json");
  await fs.writeFile(`${metaPath}.tmp`, `${JSON.stringify(meta, null, 2)}\n`);
  await fs.rename(`${metaPath}.tmp`, metaPath);
  log(`  encoded ${entry.slug} (${runtimeS}s)`);
}

async function isBuilt(distDir, slug) {
  const dir = path.join(distDir, "content", slug);
  try {
    // meta.json must not just exist — it must parse and carry a sane
    // runtime, or a torn write (killed mid-generation) would poison
    // library.json on every later run. Invalid -> rebuild the title.
    const meta = JSON.parse(
      await fs.readFile(path.join(dir, "meta.json"), "utf8"),
    );
    if (
      meta.slug !== slug ||
      !Number.isInteger(meta.runtime_s) ||
      meta.runtime_s <= 0
    ) {
      return false;
    }
    await fs.access(path.join(dir, "index.m3u8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate every missing fixture into `<distDir>/content/<slug>/`,
 * running up to `concurrency` ffmpeg encodes at once. Titles that are
 * already built (meta.json + index.m3u8 present) are skipped; partial
 * dirs are wiped and re-encoded.
 *
 * @returns {Promise<{built: string[], skipped: string[]}>}
 */
export async function generateFixtures({
  distDir,
  ffmpeg = DEFAULT_FFMPEG,
  ffprobe = DEFAULT_FFPROBE,
  // Capped by CPU count: on a small VM, 4 parallel ffmpegs can starve
  // the box hard enough that one dies with SIGSEGV.
  concurrency = Math.min(4, os.availableParallelism()),
  log = () => {},
} = {}) {
  const built = [];
  const skipped = [];
  const todo = [];
  for (const entry of TITLES) {
    if (await isBuilt(distDir, entry.slug)) skipped.push(entry.slug);
    else todo.push(entry);
  }
  if (todo.length > 0) {
    log(`encoding ${todo.length} title(s), pool of ${concurrency} ` +
      `(${skipped.length} already built)`);
  } else {
    log(`all ${skipped.length} titles already built`);
  }

  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, todo.length) },
    async () => {
      while (next < todo.length) {
        const entry = todo[next];
        next += 1;
        await encodeTitle({ entry, distDir, ffmpeg, ffprobe, log });
        built.push(entry.slug);
      }
    },
  );
  await Promise.all(workers);
  await fs.rm(path.join(distDir, ".cards"), { recursive: true, force: true });
  return { built, skipped };
}

/**
 * Assemble `<distDir>/library.json` from the per-title meta.json files
 * (the same shape `scripts/import.js` builds from an existing content
 * directory). Returns the entries, sorted by slug.
 */
export async function buildLibrary({ distDir }) {
  const contentDir = path.join(distDir, "content");
  const entries = [];
  for (const name of (await fs.readdir(contentDir)).sort()) {
    const metaPath = path.join(contentDir, name, "meta.json");
    try {
      entries.push(JSON.parse(await fs.readFile(metaPath, "utf8")));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  await fs.writeFile(
    path.join(distDir, "library.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
  return entries;
}
