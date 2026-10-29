#!/usr/bin/env bash
# Regenerates the app icons in build/ from the web app's PWA icon.
#
#   build/icon.png   512x512, as is (Windows/Linux source, README)
#   build/icon.icns  macOS, artwork inset on the canvas the way Apple's icon
#                    grid expects, so it is not larger than other dock icons
#   build/icon.ico   Windows, 16-256 px
#
# macOS only (uses sips and iconutil). The outputs are committed, so CI does
# not run this. Replace SRC with a 1024x1024 master when one exists.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$here/../../web/public/icons/icon-512.png}"
out="$here/build"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$SRC" "$out/icon.png"

# macOS: inset the artwork (~86% of the canvas), transparent padding.
sips -z 440 440 "$SRC" --out "$tmp/inset.png" >/dev/null
sips -p 512 512 "$tmp/inset.png" --out "$tmp/mac-512.png" >/dev/null
iconset="$tmp/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$tmp/mac-512.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  if [ "$double" -le 512 ]; then
    sips -z "$double" "$double" "$tmp/mac-512.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$iconset" -o "$out/icon.icns"

# Windows: PNG-compressed ICO entries.
pngs=()
for size in 16 24 32 48 64 128 256; do
  sips -z "$size" "$size" "$SRC" --out "$tmp/win-$size.png" >/dev/null
  pngs+=("$tmp/win-$size.png")
done
node "$here/scripts/png-to-ico.mjs" "$out/icon.ico" "${pngs[@]}"

echo "icons written to $out"
