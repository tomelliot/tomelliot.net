#!/usr/bin/env node
/**
 * Builds the photo gallery from an Instagram data export.
 *
 *   node tools/build-gallery.mjs <path-to-export> [--limit N]
 *
 * Two things come out of it:
 *   - gallery/photos/<id>.avif      full size, long edge capped at 1600
 *   - gallery/photos/<id>-t.avif    600x600 centre crop for the grid
 * and the manifest, injected between markers in gallery/index.html and the
 * teaser tiles injected into index.html. Both files are the only place the
 * photo list lives, so the pages stay standalone with no fetch on load.
 *
 * Place names come from the GPS in the export, matched against the anchor
 * table in tools/gallery-places.json. Anything further than MAX_KM from every
 * anchor gets no place and shows only its year.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "gallery", "photos");

const THUMB_PX = 600;
const FULL_PX = 1600;
const THUMB_QUALITY = 50;
const FULL_QUALITY = 55;
const TEASER_COUNT = 3;
const MAX_KM = 35; // how far a photo may sit from an anchor and still take its name
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const exportDir = args.find((a) => !a.startsWith("--"));
const limitArg = args.indexOf("--limit");
const limit = limitArg === -1 ? Infinity : Number(args[limitArg + 1]);

if (!exportDir) {
  console.error("usage: node tools/build-gallery.mjs <path-to-instagram-export> [--limit N]");
  process.exit(1);
}

const postsJson = path.join(exportDir, "your_instagram_activity/media/posts_1.json");
if (!fs.existsSync(postsJson)) {
  console.error(`no posts_1.json under ${exportDir}`);
  process.exit(1);
}

const anchors = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gallery-places.json"), "utf8"));

/** Great-circle distance in km. */
function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function placeFor(lat, lon) {
  // 0,0 is the export's stand-in for "no location", not a point in the Atlantic.
  if (lat == null || lon == null || (lat === 0 && lon === 0)) return null;
  let best = null;
  for (const a of anchors) {
    const km = distanceKm(lat, lon, a.lat, a.lon);
    if (!best || km < best.km) best = { km, place: a.place };
  }
  return best && best.km <= MAX_KM ? best.place : null;
}

function collect() {
  const posts = JSON.parse(fs.readFileSync(postsJson, "utf8"));
  const rows = [];
  for (const post of posts) {
    for (const media of post.media ?? []) {
      const src = path.join(exportDir, media.uri);
      if (!fs.existsSync(src)) continue; // older posts are trimmed from the export
      const exif = media.media_metadata?.photo_metadata?.exif_data ?? [];
      const geo = exif.find((e) => e.latitude != null);
      rows.push({
        id: path.basename(media.uri).replace(/\.[^.]+$/, ""),
        src,
        ts: media.creation_timestamp,
        place: placeFor(geo?.latitude, geo?.longitude),
      });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, limit);
}

async function encode(photo) {
  const full = path.join(OUT_DIR, `${photo.id}.avif`);
  const thumb = path.join(OUT_DIR, `${photo.id}-t.avif`);

  if (!fs.existsSync(full)) {
    await run("magick", [photo.src, "-auto-orient", "-resize", `${FULL_PX}x${FULL_PX}>`,
      "-quality", String(FULL_QUALITY), full]);
  }
  if (!fs.existsSync(thumb)) {
    await run("magick", [photo.src, "-auto-orient", "-resize", `${THUMB_PX}x${THUMB_PX}^`,
      "-gravity", "center", "-extent", `${THUMB_PX}x${THUMB_PX}`,
      "-quality", String(THUMB_QUALITY), thumb]);
  }

  const { stdout } = await run("magick", ["identify", "-format", "%w %h", full]);
  const [w, h] = stdout.trim().split(" ").map(Number);
  return { ...photo, w, h };
}

async function encodeAll(photos) {
  const done = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < photos.length) {
        const i = next++;
        done[i] = await encode(photos[i]);
        process.stdout.write(`\r  encoded ${done.filter(Boolean).length}/${photos.length}`);
      }
    })
  );
  process.stdout.write("\n");
  return done;
}

/** Replaces the text between `start` and `end` markers, keeping the markers. */
function inject(file, start, end, body) {
  const html = fs.readFileSync(file, "utf8");
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`markers ${start} / ${end} missing from ${file}`);
  const next = html.slice(0, from + start.length) + body + html.slice(to);
  fs.writeFileSync(file, next);
}

function caption(photo) {
  const year = new Date(photo.ts * 1000).getUTCFullYear();
  return photo.place ? `${photo.place} · ${year}` : String(year);
}

const photos = collect();
console.log(`${photos.length} photos from the export`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const encoded = await encodeAll(photos);

// The gallery holds the whole manifest. `p` is place, `y` year, `w`/`h` the
// full image's pixels so the lightbox can reserve its box before loading.
const manifest = encoded.map((p) => ({
  id: p.id,
  y: new Date(p.ts * 1000).getUTCFullYear(),
  ...(p.place ? { p: p.place } : {}),
  w: p.w,
  h: p.h,
}));

const galleryPage = path.join(ROOT, "gallery/index.html");

inject(
  galleryPage,
  "/* photos:start */",
  "/* photos:end */",
  `\n      const PHOTOS = ${JSON.stringify(manifest)};\n      `
);

// The grid ships as markup, not as something JavaScript builds, so the page
// works with scripting off: every tile is a link straight to the full image.
// The lightbox is the enhancement layered over that.
const EAGER = 12; // roughly the first screenful; the rest load as they approach
const tiles = encoded
  .map(
    (p, i) =>
      `\n            <a class="tile" href="/gallery/photos/${p.id}.avif" aria-label="Photo: ${caption(p)}"` +
      `\n              ><img src="/gallery/photos/${p.id}-t.avif" alt="Photograph — ${caption(p)}"` +
      ` width="${THUMB_PX}" height="${THUMB_PX}"` +
      `${i < EAGER ? "" : ' loading="lazy"'} decoding="async"` +
      `\n            /></a>`
  )
  .join("");
inject(galleryPage, "<!-- tiles:start -->", "<!-- tiles:end -->", `${tiles}\n          `);

const years = encoded.map((p) => new Date(p.ts * 1000).getUTCFullYear());
const span = `${Math.min(...years)}–${Math.max(...years)}`;
inject(
  galleryPage,
  "<!-- meta:start -->",
  "<!-- meta:end -->",
  `${encoded.length} photographs · ${span}`
);

// The home page carries only the newest few, as plain markup so they render
// without JavaScript and cost nothing to parse.
const teaser = encoded
  .slice(0, TEASER_COUNT)
  .map(
    (p) =>
      `\n            <a class="photo-tile" href="/gallery/#${p.id}" aria-label="Photo: ${caption(p)}"` +
      `\n              ><img src="/gallery/photos/${p.id}-t.avif" alt="" width="600" height="600"` +
      `\n            /></a>`
  )
  .join("");
const home = path.join(ROOT, "index.html");
inject(home, "<!-- photos:start -->", "<!-- photos:end -->", `${teaser}\n            `);
inject(home, "<!-- count:start -->", "<!-- count:end -->", String(encoded.length));

const bytes = fs
  .readdirSync(OUT_DIR)
  .reduce((sum, f) => sum + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`wrote ${encoded.length} photos (${(bytes / 1e6).toFixed(1)} MB) and injected both pages`);
