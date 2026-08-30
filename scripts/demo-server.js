// Demo static server: serves the viewer pages from web/, the encoded HLS
// content and compiled schedule from demo-dist/, hls.js from node_modules,
// a /time endpoint, and an in-memory ballot (core openBallot + tally).
// Zero dependencies beyond node:http. Votes reset on restart — fine for
// the demo.
//
// Standalone re-serve without regenerating anything:
//   node scripts/demo-server.js

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBallot, tally } from "@moviesaboard/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PORT = 4321;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".map": "application/json",
  ".bmp": "image/bmp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// hls.js dist file, resolved through the package so npm layout changes
// don't break us. Falls back via package.json if the subpath is blocked
// by an exports map.
function resolveHlsPath() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("hls.js/dist/hls.min.js");
  } catch {
    const pkg = require.resolve("hls.js/package.json");
    return path.join(path.dirname(pkg), "dist", "hls.min.js");
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
}

// Serve one file with a path-traversal guard: the resolved path must stay
// inside baseDir.
function sendFile(res, method, baseDir, relPath, cacheControl) {
  const resolved = path.resolve(baseDir, relPath);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    sendError(res, 403, "Forbidden");
    return;
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      sendError(res, 404, "Not found");
      return;
    }
    const headers = {
      "Content-Type": MIME[path.extname(resolved).toLowerCase()] ??
        "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": cacheControl,
    };
    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(resolved);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
}

class BodyTooLarge extends Error {}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        // Stop consuming but leave the socket alive so the 413 actually
        // reaches the client; the route handler destroys it after the
        // response is flushed.
        req.removeAllListeners("data");
        req.pause();
        reject(new BodyTooLarge("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the demo server.
 *
 * @param {object} [opts]
 * @param {number} [opts.port] listen port (default MOVIESABOARD_PORT
 *   or 4321)
 * @param {string} [opts.webDir] viewer pages (default <repo>/web)
 * @param {string} [opts.distDir] demo output (default <repo>/demo-dist)
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{server: import("node:http").Server, port: number,
 *   url: string}>}
 */
export async function startServer({
  port = Number(process.env.MOVIESABOARD_PORT) || DEFAULT_PORT,
  webDir = path.join(ROOT, "web"),
  distDir = path.join(ROOT, "demo-dist"),
  log = () => {},
} = {}) {
  webDir = path.resolve(webDir);
  distDir = path.resolve(distDir);
  const hlsPath = resolveHlsPath();

  // In-memory ballot: every demo movie, deterministically shuffled by
  // today's date. Votes live for this process only.
  let library = [];
  try {
    library = JSON.parse(
      await fsp.readFile(path.join(distDir, "library.json"), "utf8"),
    );
  } catch {
    log("warning: no library.json in demo-dist — ballot will be empty " +
      "(run `npm run demo` to generate it)");
  }
  const titleBySlug = new Map(library.map((e) => [e.slug, e.title]));

  // The schedule is compiled once per `npm run demo`; warn when re-serving
  // one whose week has already ended, instead of silently airing dead air.
  try {
    const sched = JSON.parse(
      await fsp.readFile(path.join(distDir, "schedule.json"), "utf8"),
    );
    let lastEnd = 0;
    for (const ch of sched.channels ?? []) {
      for (const a of ch.airings ?? []) lastEnd = Math.max(lastEnd, a.end);
    }
    if (lastEnd > 0 && lastEnd < Date.now()) {
      log(
        "warning: schedule.json ended " +
          new Date(lastEnd).toISOString() +
          " — every channel is off air. Run `npm run demo` to recompile.",
      );
    }
  } catch {
    // no schedule yet — demo.js is about to write one, or /schedule.json
    // will 404 and the viewer shows its retry notice.
  }
  const ballot = openBallot({
    library,
    benchSize: 12,
    history: [],
    seed: new Date().toISOString().slice(0, 10),
  });
  const votes = []; // { voter, slug, at } — in-memory only

  function ballotBody() {
    return {
      open: ballot.length > 0,
      closes: null, // the demo ballot never closes
      slugs: ballot.map((slug) => ({
        slug,
        title: titleBySlug.get(slug) ?? slug,
      })),
    };
  }

  function countsBody() {
    return tally({ ballot, votes }).counts.map((c) => ({
      slug: c.slug,
      title: titleBySlug.get(c.slug) ?? c.slug,
      votes: c.votes,
    }));
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      // One bad request must never take the station off the air.
      if (!res.headersSent) sendError(res, 500, "Internal error");
      else res.destroy();
    }
  });

  function handle(req, res) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      sendError(res, 400, "Bad request");
      return;
    }
    // NUL bytes are never valid in a path and make fs calls throw.
    if (pathname.includes("\0")) {
      sendError(res, 400, "Bad request");
      return;
    }

    if (req.method === "POST") {
      if (pathname !== "/api/vote") {
        sendError(res, 404, "Not found");
        return;
      }
      readBody(req)
        .then((raw) => {
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { ok: false, error: "malformed JSON body" });
            return;
          }
          const slug = body?.slug;
          if (typeof slug !== "string" || !ballot.includes(slug)) {
            sendJson(res, 400, { ok: false, error: "slug not on the ballot" });
            return;
          }
          // Voter identity: a client-supplied id (the vote page keeps a
          // random one in localStorage) so two browsers behind one
          // address — or two tabs on this machine — count separately;
          // fall back to the remote address.
          const voter =
            typeof body?.voter === "string" && body.voter.trim() !== ""
              ? body.voter.trim().slice(0, 64)
              : req.socket.remoteAddress || "unknown";
          votes.push({ voter, slug, at: Date.now() });
          sendJson(res, 200, { ok: true, counts: countsBody() });
        })
        .catch((err) => {
          if (err instanceof BodyTooLarge) {
            res.writeHead(413, {
              "Content-Type": "text/plain; charset=utf-8",
              Connection: "close",
            });
            res.end("Body too large\n", () => req.destroy());
          } else if (!res.headersSent) {
            sendError(res, 400, "Bad request");
          }
        });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "Method not allowed");
      return;
    }

    if (pathname === "/time") {
      sendJson(res, 200, { now: Date.now() });
    } else if (pathname === "/api/ballot") {
      sendJson(res, 200, ballotBody());
    } else if (pathname === "/schedule.json") {
      sendFile(res, req.method, distDir, "schedule.json", "no-store");
    } else if (pathname === "/vendor/hls.min.js") {
      sendFile(res, req.method, path.dirname(hlsPath),
        path.basename(hlsPath), "public, max-age=3600");
    } else if (pathname.startsWith("/content/")) {
      // Encoded HLS: playlists stay fresh, segments may cache.
      const cache = pathname.endsWith(".m3u8")
        ? "no-cache"
        : "public, max-age=3600";
      sendFile(res, req.method, distDir, `.${pathname}`, cache);
    } else if (pathname.startsWith("/assets/")) {
      sendFile(res, req.method, webDir, `.${pathname}`, "no-cache");
    } else if (pathname === "/") {
      sendFile(res, req.method, webDir, "index.html", "no-cache");
    } else if (/^\/[a-z-]+\.html$/.test(pathname)) {
      sendFile(res, req.method, webDir, `.${pathname}`, "no-cache");
    } else {
      sendError(res, 404, "Not found");
    }
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const url = `http://localhost:${server.address().port}/`;
  return { server, port: server.address().port, url };
}

// Standalone: re-serve an existing demo-dist without regenerating.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startServer({ log: (m) => console.log(`[demo-server] ${m}`) })
    .then(({ url }) => {
      console.log(`[demo-server] serving at ${url} (Ctrl+C to stop)`);
    })
    .catch((err) => {
      console.error(`[demo-server] ${err.message}`);
      process.exit(1);
    });
}
