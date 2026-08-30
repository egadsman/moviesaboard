// MoviesAboard station container entrypoint: the one long-running process
// on the station side of the compose pair. Boot sequence (every step
// restart-safe, so `restart: unless-stopped` can retry a failed boot):
//
//   1. ensure the /data layout (content/, state/, vendor/)
//   2. MOVIESABOARD_TLS=self-signed: generate certs into /data/certs if
//      missing (openssl, CN=moviesaboard.local, 3650 days)
//   3. /data/content empty and MOVIESABOARD_DEMO != off: generate the
//      demo fixtures (titles already built are skipped)
//   4. copy hls.min.js from node_modules into /data/vendor/
//   5. config: /data/station.config.json if present (missing keys filled
//      with defaults), else built from env
//   6. staleness-checked stationCompile, so library.json and
//      schedule.json exist before the server takes its first request
//   7. startServer on :4321 — internal only; nginx serves the static
//      side of /data directly and proxies just /time and /api/
//   8. repeat the staleness-checked compile every
//      MOVIESABOARD_REPLAN_MINUTES
//
// A refused plan/compile is logged and NOT fatal: the last-good
// schedule.json keeps serving and the next tick retries. Only broken
// boot preconditions (unreadable /data, failed fixture generation,
// failed cert generation when TLS was requested) exit non-zero.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { generateFixtures } from "./demo-fixtures.js";
import { stationCompile } from "./station-compile.js";
import { startServer } from "./demo-server.js";

// /data and :4321 in the container; both overridable so the entrypoint
// can be smoke-run outside docker against a scratch directory (the port
// env var is the one demo-server.js already honors).
const DATA = process.env.MOVIESABOARD_DATA_DIR || "/data";
const PORT = Number(process.env.MOVIESABOARD_PORT) || 4321;

const log = (msg) => console.log(`[station] ${msg}`);

// The standard lineup from station.yaml.example.
const DEFAULT_CHANNELS = [
  { num: 1, name: "Movies", role: "movies" },
  { num: 2, name: "Series", role: "series-grid" },
  { num: 3, name: "Marathon", role: "marathon" },
  { num: 5, name: "Requests", role: "vote" },
];

function env(name) {
  return (process.env[name] ?? "").trim();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      reject(
        e.code === "ENOENT" ? new Error(`${cmd} not found on PATH`) : e,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}:\n${err}`));
    });
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- TLS ---------------- */

async function ensureSelfSignedCerts(certsDir) {
  const fullchain = path.join(certsDir, "fullchain.pem");
  const privkey = path.join(certsDir, "privkey.pem");
  if ((await exists(fullchain)) && (await exists(privkey))) {
    log("tls: certs already present in /data/certs");
    return;
  }
  log("tls: generating self-signed cert (CN=moviesaboard.local, 3650 days)");
  // tmp + rename so a kill mid-generation never leaves a half-written
  // pair for nginx to choke on.
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256",
    "-days", "3650", "-nodes",
    "-subj", "/CN=moviesaboard.local",
    "-addext", "subjectAltName=DNS:moviesaboard.local,DNS:localhost,IP:127.0.0.1",
    "-keyout", `${privkey}.tmp`,
    "-out", `${fullchain}.tmp`,
  ]);
  await fs.rename(`${privkey}.tmp`, privkey);
  await fs.rename(`${fullchain}.tmp`, fullchain);
  log(`tls: wrote ${fullchain} + ${privkey}`);
}

async function setupTls() {
  const mode = env("MOVIESABOARD_TLS") || "off";
  if (mode === "self-signed") {
    const certsDir = path.join(DATA, "certs");
    await fs.mkdir(certsDir, { recursive: true });
    await ensureSelfSignedCerts(certsDir);
  } else if (mode === "provided") {
    for (const f of ["fullchain.pem", "privkey.pem"]) {
      if (!(await exists(path.join(DATA, "certs", f)))) {
        log(
          `WARNING: MOVIESABOARD_TLS=provided but /data/certs/${f} is ` +
            "missing — nginx TLS will fail until it appears",
        );
      }
    }
  } else if (mode !== "off") {
    log(
      `WARNING: unknown MOVIESABOARD_TLS=${JSON.stringify(mode)} ` +
        "(expected off | self-signed | provided) — treating as off",
    );
  }
}

/* ---------------- demo fixtures ---------------- */

async function contentIsEmpty(contentDir) {
  const names = await fs.readdir(contentDir);
  return names.filter((n) => !n.startsWith(".")).length === 0;
}

async function maybeGenerateDemo(contentDir) {
  const mode = env("MOVIESABOARD_DEMO") || "auto";
  if (mode === "off") return;
  if (!(await contentIsEmpty(contentDir))) return;
  log("demo: /data/content is empty — generating demo fixtures (ffmpeg)");
  const { built, skipped } = await generateFixtures({ distDir: DATA, log });
  log(
    `demo: fixtures ready (${built.length} encoded, ` +
      `${skipped.length} reused)`,
  );
}

/* ---------------- vendor ---------------- */

// hls.js dist file, resolved through the package so npm layout changes
// don't break us (same fallback as demo-server.js).
function resolveHlsPath() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("hls.js/dist/hls.min.js");
  } catch {
    const pkg = require.resolve("hls.js/package.json");
    return path.join(path.dirname(pkg), "dist", "hls.min.js");
  }
}

async function copyVendor(vendorDir) {
  const src = resolveHlsPath();
  const dest = path.join(vendorDir, "hls.min.js");
  await fs.copyFile(src, `${dest}.tmp`);
  await fs.rename(`${dest}.tmp`, dest);
  log(`vendor: hls.min.js -> ${dest}`);
}

/* ---------------- config ---------------- */

async function loadConfig() {
  const defaults = {
    station: {
      name: env("STATION_NAME") || "MoviesAboard",
      timezone:
        env("STATION_TZ") ||
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    channels: DEFAULT_CHANNELS,
    planner: { movie_break_minutes: 2, grid_minutes: 15 },
    paths: {
      content: path.join(DATA, "content"),
      public: DATA,
      root: DATA,
      state: path.join(DATA, "state"),
    },
  };

  const cfgPath = path.join(DATA, "station.config.json");
  let raw = null;
  try {
    raw = await fs.readFile(cfgPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (raw === null) {
    log("config: built from environment (no /data/station.config.json)");
    return defaults;
  }

  // An operator config that does not parse is fatal: silently falling
  // back to defaults would air the wrong station.
  let fileCfg;
  try {
    fileCfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config: ${cfgPath} is not valid JSON: ${err.message}`);
  }
  log(`config: ${cfgPath}`);
  return {
    station: { ...defaults.station, ...(fileCfg.station ?? {}) },
    channels: fileCfg.channels ?? defaults.channels,
    planner: { ...defaults.planner, ...(fileCfg.planner ?? {}) },
    paths: { ...defaults.paths, ...(fileCfg.paths ?? {}) },
  };
}

/* ---------------- compile ---------------- */

let compiling = false;

// One staleness-checked compile. Refusals (bad library, unplannable
// week) never bring the station down: stationCompile leaves the
// last-good schedule.json in place, and it set process.exitCode for its
// one-shot CLI use, which a long-running server must clear again.
async function compileTick(config, { rethrow = false } = {}) {
  if (compiling) return;
  compiling = true;
  try {
    const result = await stationCompile({
      config,
      checkStale: true,
      nowMs: Date.now(),
    });
    if (
      result.action === "plan-refused" ||
      result.action === "compile-refused"
    ) {
      process.exitCode = 0;
      log(
        `WARNING: ${result.action} — the last-good schedule.json ` +
          "(if any) keeps serving; will retry on the next tick",
      );
    }
  } catch (err) {
    if (rethrow) throw err;
    log(`WARNING: compile tick failed: ${err.message}`);
  } finally {
    compiling = false;
  }
}

/* ---------------- main ---------------- */

async function main() {
  log(`MoviesAboard station starting (data: ${DATA})`);
  const contentDir = path.join(DATA, "content");
  const stateDir = path.join(DATA, "state");
  const vendorDir = path.join(DATA, "vendor");
  await fs.mkdir(contentDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(vendorDir, { recursive: true });

  await setupTls();
  await maybeGenerateDemo(contentDir);
  await copyVendor(vendorDir);

  const config = await loadConfig();
  log(
    `station "${config.station.name}", timezone ` +
      `${config.station.timezone}, ${config.channels.length} channels`,
  );

  // Compile before serving so library.json exists for the ballot.
  await compileTick(config, { rethrow: true });

  const { server, url } = await startServer({
    port: PORT,
    distDir: DATA,
    log,
  });
  log(`serving on ${url} (internal — nginx proxies /time and /api/)`);

  const replanMinutes = Math.max(
    1,
    Number(env("MOVIESABOARD_REPLAN_MINUTES")) || 5,
  );
  const timer = setInterval(() => {
    compileTick(config).catch((err) => {
      log(`WARNING: compile tick failed: ${err.message}`);
    });
  }, replanMinutes * 60_000);
  log(`replan: staleness check every ${replanMinutes} minute(s)`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — shutting down`);
    clearInterval(timer);
    server.close(() => {
      log("server closed — bye");
      process.exit(0);
    });
    // Open HLS streams would otherwise hold close() forever.
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[station] fatal: ${err.stack || err.message || err}`);
  process.exit(1);
});
