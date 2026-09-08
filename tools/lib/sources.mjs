/**
 * Where photos come from.
 *
 * A source returns a list of normalised records, newest first:
 *
 *   { id, ts, place, caption, version, read() }
 *
 * `version` changes whenever the underlying image changes, and the pipeline
 * re-encodes on that alone — so an edit in Immich republishes, and an
 * untouched photo is never encoded twice. `read()` resolves to the image
 * bytes, and is only called for records the pipeline decided to encode.
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ *
 * Instagram data export
 * ------------------------------------------------------------------ */

const MAX_KM = 35; // how far a photo may sit from an anchor and still take its name

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

/**
 * The export has coordinates but no place names, so they come from the anchor
 * table. Immich does its own reverse geocoding and needs none of this.
 */
function placeFromAnchors(anchors, lat, lon) {
  // 0,0 is the export's stand-in for "no location", not a point in the Atlantic.
  if (lat == null || lon == null || (lat === 0 && lon === 0)) return null;
  let best = null;
  for (const a of anchors) {
    const km = distanceKm(lat, lon, a.lat, a.lon);
    if (!best || km < best.km) best = { km, place: a.place };
  }
  return best && best.km <= MAX_KM ? best.place : null;
}

export function instagramSource({ exportDir, anchorsPath }) {
  const postsJson = path.join(exportDir, "your_instagram_activity/media/posts_1.json");
  if (!fs.existsSync(postsJson)) throw new Error(`no posts_1.json under ${exportDir}`);
  const anchors = JSON.parse(fs.readFileSync(anchorsPath, "utf8"));

  return {
    name: "instagram",
    async list() {
      const posts = JSON.parse(fs.readFileSync(postsJson, "utf8"));
      const rows = [];
      for (const post of posts) {
        for (const media of post.media ?? []) {
          const file = path.join(exportDir, media.uri);
          if (!fs.existsSync(file)) continue; // older posts are trimmed from the export
          const exif = media.media_metadata?.photo_metadata?.exif_data ?? [];
          const geo = exif.find((e) => e.latitude != null);
          const stat = fs.statSync(file);
          rows.push({
            id: path.basename(media.uri).replace(/\.[^.]+$/, ""),
            ts: media.creation_timestamp,
            place: placeFromAnchors(anchors, geo?.latitude, geo?.longitude),
            caption: null,
            // Export files never change in place, so size plus mtime is enough.
            version: `${stat.size}-${Math.floor(stat.mtimeMs)}`,
            read: async () => fs.promises.readFile(file),
          });
        }
      }
      rows.sort((a, b) => b.ts - a.ts);
      return rows;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Immich
 * ------------------------------------------------------------------ */

const PAGE_SIZE = 250;

async function immichFetch(baseUrl, apiKey, endpoint, init = {}) {
  const url = `${baseUrl.replace(/\/$/, "")}/api${endpoint}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "x-api-key": apiKey,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`immich ${init.method ?? "GET"} ${endpoint} -> ${res.status} ${detail.slice(0, 200)}`);
  }
  return res;
}

/**
 * Immich tags are hierarchical: `value` is the full path ("web/gallery") and
 * `name` only the leaf. Matching either lets the tag be nested or top level.
 */
async function resolveTagId(baseUrl, apiKey, tagName) {
  const tags = await (await immichFetch(baseUrl, apiKey, "/tags")).json();
  const wanted = tagName.toLowerCase();
  const match =
    tags.find((t) => t.value?.toLowerCase() === wanted) ??
    tags.find((t) => t.name?.toLowerCase() === wanted);
  if (!match) {
    const known = tags.map((t) => t.value ?? t.name).join(", ") || "(none)";
    throw new Error(`no Immich tag named "${tagName}". Tags on this server: ${known}`);
  }
  return match.id;
}

export function immichSource({ baseUrl, apiKey, tagName, quality = "fullsize" }) {
  return {
    name: `immich:${tagName}`,
    async list() {
      const tagId = await resolveTagId(baseUrl, apiKey, tagName);
      const assets = [];
      for (let page = 1; ; page++) {
        const res = await immichFetch(baseUrl, apiKey, "/search/metadata", {
          method: "POST",
          body: JSON.stringify({
            tagIds: [tagId],
            withExif: true,
            // Trashed and archived photos carry the tag but are not on display.
            withDeleted: false,
            visibility: "timeline",
            type: "IMAGE",
            page,
            size: PAGE_SIZE,
          }),
        });
        const body = await res.json();
        assets.push(...(body.assets?.items ?? []));
        if (!body.assets?.nextPage) break;
      }

      const rows = assets.map((asset) => {
        const exif = asset.exifInfo ?? {};
        // Immich reverse-geocodes on ingest, so the place name is already there.
        const place = exif.city || exif.state || exif.country || null;
        const taken = exif.dateTimeOriginal || asset.localDateTime || asset.fileCreatedAt;
        return {
          id: asset.id,
          ts: Math.floor(new Date(taken).getTime() / 1000),
          place,
          // A description written in Immich becomes the photo's real alt text.
          caption: exif.description?.trim() || null,
          // The checksum moves whenever the file does, which is exactly when a
          // new derivative is owed.
          version: asset.checksum,
          read: async () => {
            const endpoint =
              quality === "original"
                ? `/assets/${asset.id}/original`
                : `/assets/${asset.id}/thumbnail?size=${quality}`;
            const res = await immichFetch(baseUrl, apiKey, endpoint, {
              headers: { accept: "application/octet-stream" },
            });
            return Buffer.from(await res.arrayBuffer());
          },
        };
      });
      rows.sort((a, b) => b.ts - a.ts);
      return rows;
    },
  };
}
