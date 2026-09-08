#!/usr/bin/env node
/**
 * Builds the photo gallery from a source of photographs.
 *
 *   node tools/build-gallery.mjs --source immich
 *   node tools/build-gallery.mjs --source instagram --export <path> --target local
 *
 * The run is a reconciliation, not an append: whatever the source lists is
 * what the site ends up showing. Photos added to the source are encoded and
 * published, photos removed from it are deleted from the target, and photos
 * whose bytes changed are re-encoded under a new URL. Running it twice over an
 * unchanged source writes nothing.
 *
 * gallery/manifest.json records what is currently published, including each
 * photo's source version, so a run only re-encodes what actually moved. It is
 * build state and the browser never reads it — the pages carry their own
 * trimmed copy, injected between markers.
 *
 * Configuration comes from flags or the environment; see tools/README.md.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { immichSource, instagramSource } from "./lib/sources.mjs";
import { localTarget, r2Target } from "./lib/targets.mjs";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "gallery/manifest.json");

const THUMB_PX = 600;
const FULL_PX = 2400;
const THUMB_QUALITY = 50;
const FULL_QUALITY = 55;
const TEASER_COUNT = 3;
const FETCH_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 6;

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const env = process.env;
const config = {
  source: flag("source", env.GALLERY_SOURCE ?? "immich"),
  target: flag("target", env.GALLERY_TARGET ?? (env.R2_BUCKET ? "r2" : "local")),
  limit: Number(flag("limit", env.GALLERY_LIMIT ?? Infinity)),
  dryRun: has("dry-run"),
  exportDir: flag("export", env.INSTAGRAM_EXPORT),
  immich: {
    baseUrl: flag("immich-url", env.IMMICH_URL ?? "http://immich-server:2283"),
    apiKey: env.IMMICH_API_KEY,
    tagName: flag("tag", env.IMMICH_TAG ?? "tomelliot.net"),
    quality: flag("quality", env.IMMICH_QUALITY ?? "fullsize"),
  },
  r2: {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    prefix: env.R2_PREFIX ?? "",
    base: flag("photo-base", env.PHOTO_BASE_URL),
    endpoint: env.R2_ENDPOINT, // unsigned stub, for tests
  },
};

function buildSource() {
  if (config.source === "instagram") {
    if (!config.exportDir) throw new Error("--source instagram needs --export <path-to-export>");
    return instagramSource({
      exportDir: config.exportDir,
      anchorsPath: path.join(ROOT, "tools/gallery-places.json"),
    });
  }
  if (config.source === "immich") {
    if (!config.immich.apiKey) throw new Error("--source immich needs IMMICH_API_KEY");
    return immichSource(config.immich);
  }
  throw new Error(`unknown source "${config.source}"`);
}

function buildTarget() {
  if (config.target === "local") return localTarget({ dir: path.join(ROOT, "gallery/photos") });
  if (config.target === "r2") {
    const required = config.r2.endpoint ? ["bucket", "base"] : ["accountId", "accessKeyId", "secretAccessKey", "bucket", "base"];
    for (const key of required) {
      if (!config.r2[key]) throw new Error(`--target r2 needs ${key} (see tools/README.md)`);
    }
    return r2Target(config.r2);
  }
  throw new Error(`unknown target "${config.target}"`);
}

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

async function encode(bytes, stem, scratch) {
  const input = path.join(scratch, `${stem}.src`);
  const full = path.join(scratch, `${stem}.avif`);
  const thumb = path.join(scratch, `${stem}-t.avif`);
  await fs.promises.writeFile(input, bytes);

  await run("magick", [input, "-auto-orient", "-resize", `${FULL_PX}x${FULL_PX}>`,
    "-quality", String(FULL_QUALITY), full]);
  await run("magick", [input, "-auto-orient", "-resize", `${THUMB_PX}x${THUMB_PX}^`,
    "-gravity", "center", "-extent", `${THUMB_PX}x${THUMB_PX}`,
    "-quality", String(THUMB_QUALITY), thumb]);

  const { stdout } = await run("magick", ["identify", "-format", "%w %h", full]);
  const [w, h] = stdout.trim().split(" ").map(Number);
  await fs.promises.rm(input, { force: true });
  return { full, thumb, w, h };
}

/** Runs `worker` over `items`, at most `limit` at a time. */
async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    })
  );
}

/* ------------------------------------------------------------------ *
 * Page injection
 * ------------------------------------------------------------------ */

/** Replaces the text between `start` and `end` markers, keeping the markers. */
function inject(file, start, end, body) {
  const html = fs.readFileSync(file, "utf8");
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`markers ${start} / ${end} missing from ${file}`);
  const next = html.slice(0, from + start.length) + body + html.slice(to);
  if (next === html) return false;
  fs.writeFileSync(file, next);
  return true;
}

const escapeAttr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What shows under a photo, and what a screen reader is told it is. */
const caption = (photo) => (photo.p ? `${photo.p} · ${photo.y}` : String(photo.y));
const altText = (photo) => photo.c || `Photograph — ${caption(photo)}`;

function writePages(published, base) {
  const galleryPage = path.join(ROOT, "gallery/index.html");
  const home = path.join(ROOT, "index.html");
  let changed = false;

  // `f` is the file stem. It carries a hash of the source bytes, so an edited
  // photo lands on a fresh URL rather than a stale one out of the CDN's cache.
  const runtime = published.map((p) => ({
    id: p.id, f: p.f, y: p.y,
    ...(p.p ? { p: p.p } : {}), ...(p.c ? { c: p.c } : {}),
    w: p.w, h: p.h,
  }));

  changed = inject(galleryPage, "/* base:start */", "/* base:end */",
    `\n      const PHOTO_BASE = ${JSON.stringify(base)};\n      `) || changed;
  changed = inject(galleryPage, "/* photos:start */", "/* photos:end */",
    `\n      const PHOTOS = ${JSON.stringify(runtime)};\n      `) || changed;

  const EAGER = 12; // roughly the first screenful; the rest load as they approach
  const tiles = published
    .map((p, i) =>
      `\n            <a class="tile" href="${base}/${p.f}.avif" aria-label="Photo: ${escapeAttr(caption(p))}"` +
      `\n              ><img src="${base}/${p.f}-t.avif" alt="${escapeAttr(altText(p))}"` +
      ` width="${THUMB_PX}" height="${THUMB_PX}"` +
      `${i < EAGER ? "" : ' loading="lazy"'} decoding="async"` +
      `\n            /></a>`)
    .join("");
  changed = inject(galleryPage, "<!-- tiles:start -->", "<!-- tiles:end -->", `${tiles}\n          `) || changed;

  const teaser = published
    .slice(0, TEASER_COUNT)
    .map((p) =>
      `\n            <a class="photo-tile" href="/gallery/#${p.id}" aria-label="Photo: ${escapeAttr(caption(p))}"` +
      `\n              ><img src="${base}/${p.f}-t.avif" alt="" width="600" height="600"` +
      `\n            /></a>`)
    .join("");
  changed = inject(home, "<!-- photos:start -->", "<!-- photos:end -->", `${teaser}\n            `) || changed;
  changed = inject(home, "<!-- count:start -->", "<!-- count:end -->", String(published.length)) || changed;

  return changed;
}

/* ------------------------------------------------------------------ *
 * Reconcile
 * ------------------------------------------------------------------ */

const loadManifest = () =>
  fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { base: null, photos: [] };

const filesFor = (stem) => [`${stem}.avif`, `${stem}-t.avif`];

async function main() {
  const source = buildSource();
  const target = buildTarget();
  const previous = loadManifest();
  const byId = new Map(previous.photos.map((p) => [p.id, p]));

  const wanted = (await source.list()).slice(0, config.limit);
  console.log(`${source.name}: ${wanted.length} photos`);
  if (!wanted.length && previous.photos.length) {
    // An API hiccup that returns nothing must not empty the site.
    throw new Error("source returned no photos but the site has some; refusing to publish an empty gallery");
  }

  // Republish everything if the photos moved host, since every URL changes.
  const rebased = Boolean(previous.base) && target.base !== previous.base;
  const stale = wanted.filter((p) => {
    const old = byId.get(p.id);
    return !old || old.v !== p.version || rebased;
  });
  const departed = previous.photos.filter((p) => !wanted.some((w) => w.id === p.id));

  if (config.dryRun) {
    console.log(`dry run: ${stale.length} to encode, ${departed.length} to remove`);
    for (const p of stale.slice(0, 10)) console.log(`  + ${p.id} ${p.place ?? ""}`.trimEnd());
    for (const p of departed.slice(0, 10)) console.log(`  - ${p.id}`);
    return;
  }

  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gallery-"));
  const encoded = new Map();
  try {
    let done = 0;
    await pool(stale, FETCH_CONCURRENCY, async (photo) => {
      const bytes = await photo.read();
      // Hashing the source bytes means the same photo always lands on the same
      // URL, and a changed one can never collide with its predecessor.
      const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
      const stem = `${photo.id}-${hash}`;
      encoded.set(photo.id, { stem, ...(await encode(bytes, stem, scratch)) });
      process.stdout.write(`\r  encoded ${++done}/${stale.length}`);
    });
    if (stale.length) process.stdout.write("\n");

    await pool([...encoded.values()], UPLOAD_CONCURRENCY, async (e) => {
      await target.put(`${e.stem}.avif`, await fs.promises.readFile(e.full), "image/avif");
      await target.put(`${e.stem}-t.avif`, await fs.promises.readFile(e.thumb), "image/avif");
    });
    if (encoded.size) console.log(`published ${encoded.size * 2} files to ${target.name}`);
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }

  const published = wanted.map((photo) => {
    const fresh = encoded.get(photo.id);
    const old = byId.get(photo.id);
    return {
      id: photo.id,
      f: fresh ? fresh.stem : old.f,
      v: photo.version,
      y: new Date(photo.ts * 1000).getUTCFullYear(),
      ...(photo.place ? { p: photo.place } : {}),
      ...(photo.caption ? { c: photo.caption } : {}),
      w: fresh ? fresh.w : old.w,
      h: fresh ? fresh.h : old.h,
    };
  });

  // Only now that replacements are live is it safe to drop what they replaced.
  const live = new Set(published.flatMap((p) => filesFor(p.f)));
  const obsolete = [...new Set([
    ...departed.flatMap((p) => filesFor(p.f)),
    ...stale.filter((p) => byId.has(p.id)).flatMap((p) => filesFor(byId.get(p.id).f)),
  ])].filter((file) => !live.has(file));
  if (obsolete.length) {
    await target.remove(obsolete);
    console.log(`removed ${obsolete.length} files no longer referenced`);
  }

  const pagesChanged = writePages(published, target.base);
  const manifest = JSON.stringify({ base: target.base, source: source.name, photos: published }, null, 1);
  const manifestChanged = !fs.existsSync(MANIFEST) || fs.readFileSync(MANIFEST, "utf8") !== manifest;
  if (manifestChanged) fs.writeFileSync(MANIFEST, manifest);

  const changed = pagesChanged || manifestChanged;
  console.log(changed ? `site updated: ${published.length} photos on ${target.base}` : "site already up to date");

  // The sync wrapper reads this to decide whether there is anything to commit.
  if (env.GALLERY_REPORT) {
    fs.writeFileSync(env.GALLERY_REPORT, JSON.stringify({
      changed, total: published.length, encoded: encoded.size, removed: obsolete.length,
    }));
  }
}

await main();
