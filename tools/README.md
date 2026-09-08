# Gallery tooling

The gallery is built by reconciling a **source** of photographs against a **target** that serves them. `tools/build-gallery.mjs` runs that reconciliation; `tools/sync/` wraps it in a service that runs next to Immich and pushes the result.

```
Immich (tag) ──▶ build-gallery.mjs ──▶ R2 bucket        (photos)
                        └───────────▶ git push         (the two HTML pages)
```

## How it decides what to do

Every run is a reconciliation, never an append. It asks the source what belongs in the gallery, compares that against `gallery/manifest.json`, and makes the target match:

| In the source | In the manifest | What happens |
|---|---|---|
| yes, same version | yes | nothing |
| yes, new version | yes | re-encoded, published under a new URL, old files deleted |
| yes | no | encoded and published |
| no | yes | files deleted, photo drops off the page |

Replacements are uploaded before their predecessors are deleted, so no URL is ever briefly missing. Photo filenames carry a hash of the source bytes (`<id>-<hash>.avif`), so an edit in Immich produces a new URL rather than a stale copy out of the CDN cache. A run that finds nothing to do writes nothing and makes no commit.

If the source returns an empty list while the manifest holds photos, the run aborts rather than emptying the site — an API hiccup should not wipe the gallery.

The manifest is trusted as the record of what is published. If objects are deleted from the bucket by hand, the sync will not notice the gap or repair it; delete `gallery/manifest.json` and let the next run republish everything.

## Running it by hand

```bash
# From an Immich tag to R2 (reads the environment; see sync/env.example)
node tools/build-gallery.mjs --source immich

# See what would change, without touching anything
node tools/build-gallery.mjs --source immich --dry-run

# From the Instagram export into the repo, which is what is committed today
node tools/build-gallery.mjs --source instagram \
  --export ~/Downloads/instagram-… --target local
```

Flags: `--source instagram|immich`, `--target local|r2`, `--tag`, `--immich-url`, `--photo-base`, `--quality original|fullsize`, `--limit N`, `--dry-run`. Each has an environment equivalent.

Requires ImageMagick with AVIF support. There are no npm dependencies, at any layer.

## Setting up the sync

Immich fires a workflow event when a tag is **added** to an asset. There is no event for a tag being **removed**, so the timer is the backbone and the webhook only decides how soon the next run happens. Fifteen minutes is the default; a tagged photo appears within about twenty seconds of tagging if the webhook is wired up.

**1. Immich API key** — Account Settings → API Keys. Needs read access to assets and tags.

**2. An R2 bucket with a custom domain.** Create the bucket, then attach a domain to it (`photos.tomelliot.net`). Use a real domain, not the `r2.dev` development URL, which is rate limited. Create an Object Read & Write token scoped to that bucket.

**3. A deploy key** so the container can push:

```bash
ssh-keygen -t ed25519 -f secrets/deploy_key -N "" -C "gallery-sync"
ssh-keyscan github.com > secrets/known_hosts
```

Add `secrets/deploy_key.pub` to the repo's Deploy keys with write access.

**4. The service.** Copy `sync/docker-compose.example.yml` into the Immich stack and `sync/env.example` to `.env` beside it, then fill it in and bring it up. It joins Immich's network and reaches it at `http://immich-server:2283`, so nothing is exposed to the internet and the only outbound traffic is to R2 and GitHub.

```bash
docker compose up -d gallery-sync
docker compose logs -f gallery-sync
curl localhost:8080/healthz     # only from inside the network
```

The first run clones the site repo into a volume and publishes everything in the tag, which takes a while. Later runs only touch what changed.

**5. The workflow**, for the near-instant path. Method keys differ between Immich versions, so the script reads them off your own server rather than guessing:

```bash
docker compose exec gallery-sync node /app/immich-workflow.mjs --list-methods
docker compose exec gallery-sync node /app/immich-workflow.mjs            # print it
docker compose exec gallery-sync node /app/immich-workflow.mjs --create   # create it
```

Check the printed JSON against the two methods' schemas before creating it. If the webhook step fails with a host error, add `gallery-sync:8080` to the webhook plugin's allowed hosts — Immich restricts which hosts a plugin may call.

Everything works without this step. You just wait for the next tick.

## Switching the site over to Immich

The committed gallery is still the Instagram seed served out of `gallery/photos/`. To cut over, point the sync at Immich, let it run once, and then delete `gallery/photos/` from the repo — the manifest's `base` changes, which makes the next run republish every photo to R2 and rewrite both pages. Nothing needs editing by hand.

## Files

| Path | What it is |
|---|---|
| `build-gallery.mjs` | The reconciliation: read the source, encode, publish, rewrite the pages |
| `lib/sources.mjs` | Where photos come from — the Instagram export, or an Immich tag |
| `lib/targets.mjs` | Where they are published — a directory in the repo, or R2 |
| `gallery-places.json` | Coordinate-to-place table, used only by the Instagram source; Immich reverse-geocodes for itself |
| `sync/server.mjs` | The timer, the webhook and the git push |
| `sync/immich-workflow.mjs` | Builds the Immich workflow against your server's actual method keys |
| `render-og.sh`, `render-favicons.sh` | Unrelated: the share card and the icons |

## What the pages get

`gallery/index.html` and `index.html` are rewritten between comment markers — `photos`, `tiles`, `base` and `count`. Everything outside those markers is hand-written and never touched by the build.

Each photo contributes `{ id, f, y, p?, c?, w, h }`: the file stem, year, place, caption, and the full image's dimensions so the lightbox can reserve its box before the file arrives. A description written in Immich becomes the caption under the photo and its alt text; without one, the page falls back to place and year.
