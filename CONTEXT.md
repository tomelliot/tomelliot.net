# Handover: publishing tomelliot.net's photo gallery from Immich

You are picking up a mostly-finished integration. The site and the sync tooling are written, committed and tested, and the Cloudflare side is built and verified against the real bucket. What remains is the Immich half, which could not be reached from the machine where this was built. You are on the machine that runs Immich, so you can finish it.

Read `tools/README.md` after this — it covers operating the tool. This document covers what you cannot infer from the code: why it is shaped the way it is, what has never run against real infrastructure, and what will bite you.

## The goal

Photographs tagged `tomelliot.net` in Immich appear in the gallery at https://www.tomelliot.net/gallery/. Untagging removes them. No manual step in between.

## Where things are

**Status, 2026-09-08:** live. The sync runs on pixie in `~/gallery-sync/`, `spike/photo-gallery` is merged to `main`, and the gallery serves from R2. Only the webhook accelerator is outstanding, waiting on Immich 3.2.0 (see § 5).

- **Repo:** `git@github.com:tomelliot/tomelliot.net.git`
- **Branch:** `main` (the sync pushes there directly; `spike/photo-gallery` was the development branch)
- **Site:** a hand-written static site on GitHub Pages, served from `main`. No framework, no build step for the site itself, no npm dependencies anywhere in the project.

| Path | What it is |
|---|---|
| `index.html` | Home page. Carries a three-wide photo teaser above Recent Projects. |
| `gallery/index.html` | The gallery. Grid plus lightbox, all inline. |
| `gallery/manifest.json` | Build state: what is currently published. Not read by the browser. |
| `tools/build-gallery.mjs` | The reconciliation. Reads a source, encodes, publishes, rewrites both pages. |
| `tools/lib/sources.mjs` | Instagram export, and Immich. |
| `tools/lib/targets.mjs` | A directory in the repo, and R2. |
| `tools/sync/server.mjs` | The service: timer, webhook listener, git push, one lock. |
| `tools/sync/immich-workflow.mjs` | Builds the Immich workflow against your server's actual plugin method keys. |
| `tools/sync/verify-r2.mjs` | One-command check that R2 credentials, signing, public read and delete all work. |
| `tools/sync/Dockerfile`, `docker-compose.example.yml`, `env.example` | Deployment. |
| `tools/README.md` | Operating manual. |

`gallery/photos/` is gitignored. It only exists for local builds; published photos go to R2.

## The one constraint that shapes everything

Immich v3.0.0 added Workflows. On the server this runs against (**3.1.0**, checked 2026-09-08) the trigger enum is exactly:

```
AssetCreate | AssetMetadataExtraction
```

`AssetTagged` — which fires when a tag is **added** to an asset — and the matching tag filter arrived in [immich-app/immich#29043](https://github.com/immich-app/immich/pull/29043), merged 2026-08-12, two weeks after 3.1.0 shipped. It is in the 3.2.0 release candidates and will be available once pixie's Immich moves to 3.2.0. Even then, **there is no trigger for a tag being removed**, and none for a description or date being edited. A webhook-driven design could therefore add photos to the site and never take one off.

So the timer is the backbone and the webhook is only an accelerator. Every run asks Immich for the tag's entire contents and makes the site match — additions, removals and metadata edits all converge, and the run is idempotent. The webhook decides *when* the next run happens, never *what* it does; its payload is deliberately ignored, which also means the integration cannot break when Immich changes that payload's shape.

**Do not "simplify" this into a webhook-only design.** It will look like it works, and then a photo you untag will stay on the public site forever.

## What is done

The whole pipeline, exercised end to end against stub Immich and R2 servers built from the published OpenAPI spec. Verified: pagination across pages, no-op when nothing changed, untag causing deletion, edit producing a new content-hashed URL with the replacement uploaded *before* the old one is purged, the guard that refuses to publish an empty gallery if the API returns nothing, webhook auth, six webhooks in a burst collapsing into one sync, push races rebasing onto another author's commit rather than clobbering it, and the full cutover from repo-hosted photos to R2.

The gallery front end is finished and verified in a browser: grid at 3/4/5 columns, full-bleed on phones, lightbox with keyboard, swipe, deep links and browser-back, focus management, and zero axe violations on both pages. It works with JavaScript disabled — every tile is a plain link to the full image, and the lightbox is an enhancement layered over that. Keep it that way.

## Already done, and proven against the real thing

The Cloudflare side is built and verified. You do not need to create anything there.

| | |
|---|---|
| Bucket | `tomelliot-photos`, location WEUR |
| Account ID | `842832afb8f60617da8555ec2d63ade5` |
| Public domain | `https://photos.tomelliot.net` — ownership active, SSL active |
| Zone ID | `feb518dc3908f1641b99310f08fc3f18` (tomelliot.net was already on Cloudflare, which is what made a custom domain possible) |
| Token | Object Read & Write, scoped to that bucket only |
| Credentials | `~/gallery-sync/.env` on pixie, mode 600, gitignored (moved off `/tmp` on 2026-09-08) |

`tools/lib/targets.mjs` implements SigV4 by hand, with no npm dependencies anywhere in this project, deliberately, since the sync container holds both Immich and GitHub credentials. That signing has now been exercised against the real bucket: signed PUT, GET, LIST and DELETE all work, objects persist, and the public domain serves them at 200 with `cache-control: public, max-age=31536000, immutable`. That header is safe because filenames carry a hash of the source bytes, so a given URL's content can never change.

Re-confirm it on your machine in one command before going further:

```bash
node tools/sync/verify-r2.mjs --env-file /tmp/.env
```

Two things that will mislead you while checking R2 by hand, both encountered during setup:

- `wrangler r2 object get <bucket>/<key>` reported *"The specified key does not exist"* for objects that were demonstrably there — a signed GET and a signed LIST both returned them. Trust the S3 API over wrangler here.
- `wrangler r2 bucket info` reports `object_count: 0` straight after an upload. That metric lags; it is not evidence of anything.

## Verified against real infrastructure on pixie, 2026-09-08

Everything has now run for real. What the live server taught us, for the record:

1. **Real Immich responses match the adapter.** `POST /search/metadata` on 3.1.0 returns exactly the fields the adapter reads (`id`, `checksum`, `localDateTime`, `exifInfo.{city,state,country,dateTimeOriginal,description}`, plus `thumbhash` and the camera fields). Of the 175 assets tagged at the time, 173 were images, 169 had a reverse-geocoded city, all had `dateTimeOriginal`, and none had a description.
2. **`thumbnail?size=fullsize` is a 302 to `/original` for JPEG originals.** Full-size derivatives are not generated on this server (and enabling them would reprocess a 61k-asset library), so Immich redirects to the original instead. Node's `fetch` follows the redirect, but `/original` needs the **`asset.download`** permission on the API key, or every run fails with a 403 on the first download. The gallery key now carries `asset.read`, `asset.view`, `asset.download`, `tag.read`.
3. **The container image needed three fixes** (commits `43328d9`, `10a0619`): Alpine ships a built-in `sync` user, so the service user is now `gallery` (uid 1001); Alpine's libheif carries AVIF *decoders* only, so `libheif-aom` supplies the encoder; and each ImageMagick delegate is its own package, so `imagemagick-jpeg` is needed to read the originals at all. The boot check in `server.mjs` now requires AVIF's write flag rather than its presence, because the decoder-only build passed the old check and failed at the first encode.
4. **Encode cost on pixie** (i5-4250U, 4 cores): about 2.5 s per full-size AVIF and 0.8 s per thumbnail, four in flight, peaking at ~390 MiB. The first full run (173 photos, 346 uploads) took ten and a half minutes; an unchanged run takes a few seconds.

## Setup, in order

### 1. Confirm the Immich side by hand

Before touching the container. Create an API key in Immich under Account Settings → API Keys with `asset.read`, `asset.view`, `asset.download` and `tag.read` (`asset.download` because `size=fullsize` redirects to `/original`, see above), then:

```bash
export IMMICH_URL=http://immich-server:2283      # or http://localhost:2283 from the host
export IMMICH_API_KEY=...

# Does the tag exist, and what is its id?
curl -s -H "x-api-key: $IMMICH_API_KEY" "$IMMICH_URL/api/tags" | jq '.[] | {id, name, value}'

# How many assets carry it? (substitute the id)
curl -s -X POST -H "x-api-key: $IMMICH_API_KEY" -H 'content-type: application/json' \
  -d '{"tagIds":["<id>"],"withExif":true,"size":5,"page":1}' \
  "$IMMICH_URL/api/search/metadata" | jq '.assets | {total, sample: (.items[0] | {id, checksum, exifInfo: {city, country, dateTimeOriginal, description}})}'
```

The second call is the important one. Confirm `exifInfo.city` is populated — the gallery's place names come from Immich's own reverse geocoding, not from coordinates. If cities are null, Immich has not reverse-geocoded that library and photos will show only a year.

Create the tag if it does not exist. The name is `tomelliot.net`; the tool matches on either a tag's `value` (full path, for nested tags) or its `name`.

### 2. Confirm R2 from your machine

Already created and verified from elsewhere; this just proves the credentials work where the sync will actually run.

```bash
git clone git@github.com:tomelliot/tomelliot.net.git && cd tomelliot.net
git checkout spike/photo-gallery
node tools/sync/verify-r2.mjs --env-file /tmp/.env
```

Expect four ticks and `R2 works`. A `fetch failed` on the public read is almost always the local resolver rather than Cloudflare — check with `dig @1.1.1.1 +short photos.tomelliot.net`, and if that answers but your machine does not, it is your DNS cache. (That is exactly what happened on the machine this was built on.)

Requires ImageMagick with AVIF support (`magick -list format | grep AVIF`) and Node 20+.

### 3. Deploy key

The container pushes the site repo over SSH:

```bash
ssh-keygen -t ed25519 -f secrets/deploy_key -N "" -C "gallery-sync"
ssh-keyscan github.com > secrets/known_hosts
```

Add `secrets/deploy_key.pub` to the repo's Deploy keys **with write access** (`gh repo deploy-key add secrets/deploy_key.pub -R tomelliot/tomelliot.net --allow-write --title "gallery-sync (pixie)"`).

The container runs as uid 1001, so the private key must be owned by that uid or ssh refuses it: `sudo chown 1001:1001 secrets/deploy_key`. `known_hosts` can stay world-readable.

### 4. The service

On pixie this lives as its own stack at `~/gallery-sync/` (compose file, `.env`, `secrets/`), joined to the `immich_default` network — the same pattern as the pet-tagger sidecar, rather than a service inside `~/immich-app`, whose `.env` holds the database password. The image is built from `~/tomelliot.net/tools/sync` (a plain clone of this repo, used as the build context only). The interval is **5 minutes** there, because without the webhook the timer is the only path.

Elsewhere: copy `tools/sync/docker-compose.example.yml` into the Immich stack and `tools/sync/env.example` to `.env` beside it, then fill it in. The service reaches Immich at `http://immich-server:2283` — nothing is exposed to the internet, and the only outbound traffic is to R2 and GitHub. Check the network name in the compose file matches your stack (it assumes `immich_default`).

Start with `SYNC_DRY_RUN=true` for the first run: the pipeline executes fully, including uploads, but nothing is committed or pushed.

```bash
docker compose up -d gallery-sync
docker compose logs -f gallery-sync
```

The first real run publishes everything in the tag and takes a while. Later runs only touch what changed.

### 5. The webhook, last — blocked until Immich 3.2.0

**Not created on pixie.** Immich 3.1.0 offers neither the `AssetTagged` trigger nor a tag filter method; run in print mode the script correctly refuses and lists the twelve methods the server does have. Everything works without it; you just wait up to five minutes. Once Immich is on 3.2.0, come back here. The management key for this step needs `workflow.*`, `plugin.read` and `tag.read`; the script can run on the host with `IMMICH_URL=http://localhost:2283`. Plugin method keys differ between Immich versions, so the script reads them off your server rather than guessing:

```bash
docker compose exec gallery-sync node /app/immich-workflow.mjs --list-methods
docker compose exec gallery-sync node /app/immich-workflow.mjs             # print the JSON
docker compose exec gallery-sync node /app/immich-workflow.mjs --create    # create it
```

Check the two config blocks against each method's schema before creating. The webhook action's config keys (`url`, `method`, `headerName`, `headerValue`) are the script's best guess from the PR that added the feature and are the most likely thing to need correcting. If the webhook step fails with a host error, add `gallery-sync:8080` to the webhook plugin's allowed hosts — Immich restricts which hosts a plugin may call.

Verify with `docker compose logs gallery-sync` after tagging a photo: you should see `sync start (webhook)` about twenty seconds later.

## Cutover and merge

The committed gallery still points at `/gallery/photos/…`, which is no longer in the repo. **Merging this branch to `main` before the sync has run will publish a gallery of broken images.** Pages serves `main`, so the branch existing is harmless.

The cutover is automatic. `gallery/manifest.json` records the base photos were published to; when that changes from `/gallery/photos` to your R2 domain, the next run republishes everything and rewrites both pages. Sequence:

1. Point the sync at Immich and R2 and let it run once.
2. Confirm the pushed `gallery/index.html` references your R2 domain.
3. Merge `spike/photo-gallery` to `main`.

After merging, the sync pushes to `main` directly (`GIT_BRANCH=main`).

## Gotchas

**Manifest drift is not self-healing.** The manifest is trusted as the record of what is published. Delete objects from the bucket by hand and the sync will not notice the gap or repair it. Remedy: delete `gallery/manifest.json` and let the next run republish everything. This is not theoretical — it happened during development when photos were removed from disk and the build cheerfully reported "already up to date".

**The container runs the repo's own `tools/`, not the image's.** It clones the site repo into a volume and executes `tools/build-gallery.mjs` from that clone. Changes to the pipeline must be committed and pushed before the container will use them. Only `server.mjs` and `immich-workflow.mjs` live in the image.

**Every run resets to `origin/<branch>` before building.** Uncommitted changes in the container's clone are discarded. Do not use it as a working copy.

**Moving photos between hosts does not delete the old copies.** When the base changes, the previous target's files are reported as orphaned and left alone rather than deleted through the new target. After cutover, the old `gallery/photos/` files are already out of git; nothing else needs cleaning.

**Filenames carry a hash of the source bytes** (`<asset-id>-<hash8>.avif`). An edit in Immich lands on a new URL rather than a stale copy out of the CDN cache, and replacements upload before their predecessors are purged, so no URL is ever briefly missing.

**A run that returns zero photos while the manifest holds some aborts.** An API hiccup must not empty the site. If you genuinely want to empty the gallery, delete the manifest.

## Immich API reference, as verified

Auth is the `x-api-key` header. All paths are under `/api`.

| Endpoint | Use |
|---|---|
| `GET /tags` | Resolve the tag name to an id. Tags are hierarchical: `value` is the full path, `name` the leaf. |
| `POST /search/metadata` | `{tagIds, withExif, visibility, type, page, size}`. Paginate on `assets.nextPage`. |
| `GET /assets/{id}/thumbnail?size=fullsize` | What the sync downloads. `size` accepts `original\|fullsize\|preview\|thumbnail`. When no full-size derivative exists (the default), this is a **302 to `original`** for web-friendly originals, so the key needs `asset.download` too. |
| `GET /assets/{id}/original` | The raw file, if you set `IMMICH_QUALITY=original`, and where `fullsize` lands in practice. |
| `GET /api-keys/me` | What a key is allowed to do — the fastest way to explain a 403. |
| `GET /plugins/methods` | Workflow plugin methods, with keys and schemas. |
| `GET /workflows/triggers`, `POST /workflows` | Workflow management. |

Per asset the tool uses `id`, `checksum` (change detection), `localDateTime`, and from `exifInfo`: `city`, `state`, `country`, `dateTimeOriginal`, `description`.

Two fields are available and unused, if you want them later: `thumbhash` (a tiny blur placeholder that could be inlined while thumbnails load) and the camera fields (`make`, `model`, `lensModel`, `fNumber`, `iso`, `exposureTime`).

## Do not break these

The gallery front end was built to a deliberate standard. If you touch `gallery/index.html`:

- **It works without JavaScript.** The grid is server-rendered markup and every tile is a plain link to the full image. The lightbox is an enhancement.
- **Zero axe violations, and contrast is checked.** The caption and counter under a lightbox photo sit at 5.7:1 and 5.0:1 against the backdrop. The counter was at 2.3:1 and had to be fixed; do not darken it again.
- **Both pages are rewritten only between comment markers** — `photos`, `tiles`, `base`, `count`. Everything outside them is hand-written and the build never touches it. Adding content is safe; moving a marker is not.
- **Motion respects `prefers-reduced-motion`,** and the lightbox traps focus, restores it on close, and locks body scroll while open.

A description written in Immich becomes the caption under the photo *and* its alt text. Without one, the page falls back to "place · year". Writing descriptions in Immich is the intended way to give photos real alt text.

## Local preview

```bash
node tools/build-gallery.mjs --source instagram --export <path-to-export> --target local
python3 -m http.server 8912     # then open http://localhost:8912/gallery/
```

The Instagram export path is the original seed and still works. It is the only user of `tools/gallery-places.json`, a hand-built coordinate-to-place table that Immich makes unnecessary.
