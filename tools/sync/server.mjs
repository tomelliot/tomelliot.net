#!/usr/bin/env node
/**
 * Keeps the published gallery in step with an Immich tag.
 *
 * One process holds three things: a timer, a webhook listener, and the git
 * push. All three funnel into a single reconcile, and only one reconcile runs
 * at a time.
 *
 * The timer is the backbone. Immich fires a workflow event when a tag is
 * ADDED to an asset but has no event for a tag being removed, so a webhook
 * alone could add photos to the site and never take one off. Every run
 * therefore asks Immich for the tag's full contents and makes the site match,
 * which converges whatever happened in between. The webhook only decides when
 * the next run happens, never what it does — so its payload is ignored, and
 * the integration cannot break when that payload changes shape.
 *
 * Endpoints:
 *   POST /hook     nudge a run (needs WEBHOOK_SECRET in x-webhook-secret)
 *   GET  /healthz  liveness, plus the last run's outcome
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const env = process.env;
const REPO_DIR = env.REPO_DIR ?? "/data/site";
const REPO_URL = env.REPO_URL;
const BRANCH = env.GIT_BRANCH ?? "main";
const PORT = Number(env.PORT ?? 8080);
const INTERVAL_MS = Number(env.SYNC_INTERVAL_SECONDS ?? 900) * 1000;
// Tagging a batch of photos fires one webhook each; waiting out the burst
// turns twenty pings into one reconcile.
const DEBOUNCE_MS = Number(env.WEBHOOK_DEBOUNCE_SECONDS ?? 20) * 1000;
const SECRET = env.WEBHOOK_SECRET;
const DRY_RUN = env.SYNC_DRY_RUN === "true";

const log = (...args) => console.log(new Date().toISOString(), ...args);

let running = false;
let rerunRequested = false;
let debounceTimer = null;
let last = { at: null, ok: null, detail: "no run yet" };

async function git(args, opts = {}) {
  const { stdout } = await exec("git", args, { cwd: REPO_DIR, ...opts });
  return stdout.trim();
}

async function ensureRepo() {
  if (fs.existsSync(path.join(REPO_DIR, ".git"))) return;
  if (!REPO_URL) throw new Error("REPO_DIR holds no clone and REPO_URL is unset");
  log(`cloning ${REPO_URL.replace(/\/\/[^@]*@/, "//***@")}`);
  fs.mkdirSync(path.dirname(REPO_DIR), { recursive: true });
  await exec("git", ["clone", "--branch", BRANCH, REPO_URL, REPO_DIR]);
  await git(["config", "user.name", env.GIT_AUTHOR_NAME ?? "gallery-sync"]);
  await git(["config", "user.email", env.GIT_AUTHOR_EMAIL ?? "gallery-sync@localhost"]);
}

async function reconcile() {
  await ensureRepo();

  // Start from the published state, or a stale manifest would re-encode
  // everything and fight with whatever was pushed from elsewhere.
  await git(["fetch", "origin", BRANCH]);
  await git(["reset", "--hard", `origin/${BRANCH}`]);

  const report = path.join(REPO_DIR, ".sync-report.json");
  fs.rmSync(report, { force: true });
  const { stdout, stderr } = await exec("node", ["tools/build-gallery.mjs"], {
    cwd: REPO_DIR,
    env: { ...env, GALLERY_REPORT: report },
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = (stdout + stderr).trim();
  if (output) log(output.split("\n").pop());

  const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : { changed: false };
  fs.rmSync(report, { force: true });

  const dirty = await git(["status", "--porcelain"]);
  if (!dirty) return { ...result, pushed: false, detail: "no change" };
  if (DRY_RUN) {
    log("dry run: would commit\n" + dirty);
    await git(["checkout", "--", "."]);
    return { ...result, pushed: false, detail: "dry run" };
  }

  const summary =
    `chore: Sync gallery from Immich\n\n` +
    `${result.total} photos published. ${result.encoded} encoded, ${result.removed} removed.\n`;
  await git(["add", "-A"]);
  await git(["commit", "-m", summary]);

  // Someone may have pushed while this ran; rebase rather than clobber.
  try {
    await git(["push", "origin", `HEAD:${BRANCH}`]);
  } catch {
    log("push rejected, rebasing onto the remote and retrying");
    await git(["pull", "--rebase", "origin", BRANCH]);
    await git(["push", "origin", `HEAD:${BRANCH}`]);
  }
  return { ...result, pushed: true, detail: `pushed ${result.total} photos` };
}

async function runSync(reason) {
  if (running) {
    // Collapse everything that arrives mid-run into exactly one follow-up.
    rerunRequested = true;
    log(`${reason}: a sync is already running, queued a follow-up`);
    return;
  }
  running = true;
  try {
    log(`sync start (${reason})`);
    const result = await reconcile();
    last = { at: new Date().toISOString(), ok: true, detail: result.detail };
    log(`sync done: ${result.detail}`);
  } catch (error) {
    last = { at: new Date().toISOString(), ok: false, detail: error.message };
    // A failed run must not take the process down; the next tick retries.
    log(`sync failed: ${error.message}`);
  } finally {
    running = false;
    if (rerunRequested) {
      rerunRequested = false;
      setTimeout(() => runSync("queued follow-up"), 1000);
    }
  }
}

function nudge(reason) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runSync(reason), DEBOUNCE_MS);
}

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && req.url === "/healthz") {
    return send(last.ok === false ? 500 : 200, { running, last });
  }

  if (req.method === "POST" && req.url === "/hook") {
    if (!SECRET || req.headers["x-webhook-secret"] !== SECRET) {
      log("rejected a webhook with a bad or missing secret");
      return send(401, { error: "unauthorized" });
    }
    // The body says which asset was tagged. It is deliberately not read: the
    // reconcile reads the whole tag anyway, so the payload cannot matter.
    req.resume();
    nudge("webhook");
    return send(202, { queued: true, inSeconds: DEBOUNCE_MS / 1000 });
  }

  send(404, { error: "not found" });
});

/** Fails loudly at boot rather than part-way through the first encode. */
async function checkImageMagick() {
  try {
    const { stdout } = await exec("magick", ["-list", "format"]);
    if (!/^\s*AVIF\*?\s/m.test(stdout)) {
      throw new Error("ImageMagick has no AVIF delegate (install imagemagick-heic)");
    }
  } catch (error) {
    log(`FATAL: ${error.message}`);
    process.exit(1);
  }
}

await checkImageMagick();

server.listen(PORT, () => {
  log(`listening on :${PORT}, reconciling every ${INTERVAL_MS / 1000}s`);
  if (!SECRET) log("WEBHOOK_SECRET is unset — /hook will reject every request");
  runSync("startup");
  setInterval(() => runSync("interval"), INTERVAL_MS);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`${signal}, shutting down`);
    server.close(() => process.exit(0));
  });
}
