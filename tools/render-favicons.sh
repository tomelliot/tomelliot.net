#!/usr/bin/env bash
#
# Generate favicon/ from headshot.avif.
#
#   tools/render-favicons.sh
#
# headshot.avif is the squircle: the shape lives in its alpha channel, not in
# anything drawn here. So nothing is cropped and no mask is applied — a crop
# would eat the corners the file arrived with, and a mask would round them
# twice. Resize is the whole job.
#
# apple-touch-icon.png is the one exception and comes from headshot.jpg, the
# unmasked square. iOS puts its own superellipse over that icon, so handing it
# a pre-squircled image rounds it twice and leaves a visible double edge.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="headshot.avif"
SQUARE="headshot.jpg"
OUT="favicon"

# Resized once to 1024 and then stepped down from there, rather than going to
# each size straight off 1893px: one good downsample beats five, and the 16px
# icon is the one that shows it.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
magick "$SRC" -colorspace sRGB -resize 1024x1024 PNG32:"$TMP/master.png"

for sz in 16 32 48 192 512; do
    magick "$TMP/master.png" -filter Lanczos -resize "${sz}x${sz}" \
        -strip PNG32:"$TMP/icon-$sz.png"
done

# 16/32/48 in one .ico, which is what Windows and the older tab chrome read.
magick "$TMP/icon-16.png" "$TMP/icon-32.png" "$TMP/icon-48.png" "$OUT/favicon.ico"

cp "$TMP/icon-16.png" "$OUT/favicon-16x16.png"
cp "$TMP/icon-32.png" "$OUT/favicon-32x32.png"
cp "$TMP/icon-192.png" "$OUT/android-chrome-192x192.png"
cp "$TMP/icon-512.png" "$OUT/android-chrome-512x512.png"

magick "$SQUARE" -colorspace sRGB -resize 180x180 -strip PNG24:"$OUT/apple-touch-icon.png"

for f in "$OUT"/*.png; do
    magick "$f" -define png:compression-level=9 -strip "$f"
done

echo "render-favicons: wrote"
for f in "$OUT"/*.png "$OUT/favicon.ico"; do
    printf '  %-40s %s\n' "$f" "$(magick identify -format '%wx%h, %b' "$f[0]")"
done
