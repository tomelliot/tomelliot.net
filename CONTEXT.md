# Handover: publishing tomelliot.net's photo gallery from Immich

You are picking up a mostly-finished integration. The site and the sync tooling are written, committed and tested; what remains is wiring them to the real Immich server and R2 bucket, which could not be done on the machine where this was built. You are on the machine that runs Immich, so you can finish it.

Read `tools/README.md` after this — it covers operating the tool. This document covers what you cannot infer from the code: why it is shaped the way it is, what has never run against real infrastructure, and what will bite you.

## The goal

Photographs tagged `tomelliot.net` in Immich appear in the gallery at https://www.tomelliot.net/gallery/. Untagging removes them. No manual step in between.

## Where things are

- **Repo:** `git@github.com:tomelliot/tomelliot.net.git`
- **Branch:** `spike/photo-gallery` (pushed; six commits ahead of `main`)
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
| `tools/sync/Dockerfile`, `docker-compose.example.yml`, `env.example` | Deployment. |
| `tools/README.md` | Operating manual. |

`gallery/photos/` is gitignored. It only exists for local builds; published photos go to R2.

## The one constraint that shapes everything

Immich v3.0.0 added Workflows. The trigger enum is exactly:

```
AssetCreate | AssetMetadataExtraction | AssetTagged
```

`AssetTagged` fires when a tag is **added** to an asset. **There is no trigger for a tag being removed**, and none for a description or date being edited. A webhook-driven design could therefore add photos to the site and never take one off.

So the timer is the backbone and the webhook is only an accelerator. Every run asks Immich for the tag's entire contents and makes the site match — additions, removals and metadata edits all converge, and the run is idempotent. The webhook decides *when* the next run happens, never *what* it does; its payload is deliberately ignored, which also means the integration cannot break when Immich changes that payload's shape.

**Do not "simplify" this into a webhook-only design.** It will look like it works, and then a photo you untag will stay on the public site forever.

## What is done

The whole pipeline, exercised end to end against stub Immich and R2 servers built from the published OpenAPI spec. Verified: pagination across pages, no-op when nothing changed, untag causing deletion, edit producing a new content-hashed URL with the replacement uploaded *before* the old one is purged, the guard that refuses to publish an empty gallery if the API returns nothing, webhook auth, six webhooks in a burst collapsing into one sync, push races rebasing onto another author's commit rather than clobbering it, and the full cutover from repo-hosted photos to R2.

The gallery front end is finished and verified in a browser: grid at 3/4/5 columns, full-bleed on phones, lightbox with keyboard, swipe, deep links and browser-back, focus management, and zero axe violations on both pages. It works with JavaScript disabled — every tile is a plain link to the full image, and the lightbox is an enhancement layered over that. Keep it that way.

## What has never run against real infrastructure

Treat these three as the risk list. Everything else has been exercised.

1. **R2 signing.** `tools/lib/targets.mjs` implements SigV4 by hand for PUT and DELETE (no npm dependencies anywhere in this project, deliberately, since the container holds both Immich and GitHub credentials). It has only been exercised against an unsigned stub via the `R2_ENDPOINT` override. The signing itself is unverified. **Test this first** — see below.
2. **Real Immich responses.** The Immich adapter was written against the OpenAPI spec at `open-api/immich-openapi-specs.json` and tested against a stub shaped from it. Field names are taken from the spec, not observed from a live server.
3. **The container image.** No Docker daemon was available. In particular, that Alpine's `imagemagick-heic` really does provide ImageMagick's AVIF delegate is an assumption. `server.mjs` checks it at boot and exits with a clear message if it is missing, so this fails loudly rather than half-way through the first encode.

## Setup, in order

### 1. Confirm the Immich side by hand

Before touching the container. Create an API key in Immich under Account Settings → API Keys (needs read access to assets and tags), then:

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

### 2. Prove the R2 path

The riskiest untested piece. Create the bucket, attach a **custom domain** to it in the R2 dashboard (the `r2.dev` development URL is rate limited and not for production), and create an Object Read & Write token scoped to that bucket. Then, from a checkout on this machine:

```bash
git clone git@github.com:tomelliot/tomelliot.net.git && cd tomelliot.net
git checkout spike/photo-gallery

export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=...
export PHOTO_BASE_URL=https://photos.tomelliot.net
export IMMICH_URL=... IMMICH_API_KEY=... IMMICH_TAG=tomelliot.net

node tools/build-gallery.mjs --source immich --dry-run    # nothing is written
node tools/build-gallery.mjs --source immich --limit 2    # two photos, for real
```

If the signing is wrong you will see `r2 PUT … -> 401` or `403` immediately. Fix it in `tools/lib/targets.mjs`; the alternative is adding `@aws-sdk/client-s3`, which means introducing the project's first npm dependency and a `package.json` — acceptable if hand-rolled signing proves troublesome, but weigh it against putting a dependency tree in a container that holds both sets of credentials.

Then confirm the two objects are actually reachable at `$PHOTO_BASE_URL/<stem>.avif` in a browser. A 200 from R2 but a 403 from the custom domain means the bucket's public access or domain binding is not configured.

Requires ImageMagick with AVIF support (`magick -list format | grep AVIF`) and Node 20+.

### 3. Deploy key

The container pushes the site repo over SSH:

```bash
ssh-keygen -t ed25519 -f secrets/deploy_key -N "" -C "gallery-sync"
ssh-keyscan github.com > secrets/known_hosts
```

Add `secrets/deploy_key.pub` to the repo's Deploy keys **with write access**.

### 4. The service

Copy `tools/sync/docker-compose.example.yml` into the Immich stack and `tools/sync/env.example` to `.env` beside it. Fill it in. The service joins Immich's Docker network and reaches it at `http://immich-server:2283` — nothing is exposed to the internet, and the only outbound traffic is to R2 and GitHub. Check the network name in the compose file matches your stack (it assumes `immich_default`).

Start with `SYNC_DRY_RUN=true` for the first run: the pipeline executes fully, including uploads, but nothing is committed or pushed.

```bash
docker compose up -d gallery-sync
docker compose logs -f gallery-sync
```

The first real run publishes everything in the tag and takes a while. Later runs only touch what changed.

### 5. The webhook, last

Everything works without this; you just wait up to fifteen minutes. Plugin method keys differ between Immich versions, so the script reads them off your server rather than guessing:

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
| `GET /assets/{id}/thumbnail?size=fullsize` | What the sync downloads. `size` accepts `original\|fullsize\|preview\|thumbnail`. |
| `GET /assets/{id}/original` | The raw file, if you set `IMMICH_QUALITY=original`. |
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
