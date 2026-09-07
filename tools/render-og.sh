#!/usr/bin/env bash
#
# Render the Open Graph card to og.jpg.
#
#   tools/render-og.sh              # -> og.jpg
#   tools/render-og.sh out.jpg      # explicit output
#
# The composition is in tools/og/og.html; read it before changing any number
# here. This script only knows how big the image is and how to get a browser
# to draw it.
#
# Rendered at 2x and downsampled, so the type is antialiased against twice the
# pixels it ships with. The photograph nets out at about 0.7x of portrait.jpg
# either way, so nothing is being upscaled to pay for it.
#
# JPEG, not PNG, and that is a functional choice rather than a habit: the same
# card is 428KB as a PNG and 95KB here, and WhatsApp fetches no preview at all
# over about 300KB. Quality 92 with no chroma subsampling, so the type edges
# survive — at 1:1 against the PNG the words are indistinguishable.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-og.jpg}"
W=1200
H=630

# Any Chromium build. Playwright's is preferred when it is there, because it is
# the one that is version-pinned rather than whatever the machine happens to
# have installed.
BROWSER=""
for candidate in \
    "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium \
    /Applications/Chromium.app/Contents/MacOS/Chromium \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    /Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser; do
    [ -x "$candidate" ] && BROWSER="$candidate" && break
done
[ -n "$BROWSER" ] || { echo "render-og: no Chromium build found" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Some Chromium builds write the screenshot and then sit there rather than
# exiting, so it is capped where a cap is available and judged on its output
# rather than on its exit status either way.
CAP=""
command -v timeout >/dev/null && CAP="timeout 60"
command -v gtimeout >/dev/null && CAP="gtimeout 60"

$CAP "$BROWSER" \
    --headless \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=2 \
    --window-size="$W,$H" \
    --screenshot="$TMP/2x.png" \
    --user-data-dir="$TMP/profile" \
    "file://$PWD/tools/og/og.html" >/dev/null 2>&1 || true

[ -s "$TMP/2x.png" ] || { echo "render-og: $BROWSER wrote no screenshot" >&2; exit 1; }

# Down to 1x from twice the pixels, and flattened onto the card's own ground so
# nothing is left for a scraper to composite against white.
magick "$TMP/2x.png" -background "rgb(18,20,20)" -alpha remove -alpha off \
    -filter Lanczos -resize "${W}x${H}" \
    -quality 92 -sampling-factor 1x1 -interlace JPEG -strip "$OUT"

echo "render-og: wrote $OUT ($(magick identify -format '%wx%h, %b' "$OUT"))"
