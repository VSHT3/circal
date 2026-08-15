#!/usr/bin/env bash
# ------------------------------------------------------------------ #
# Bundles `dist/` and `mac/main.swift` into `mac/build/circal.app`.
#
# No Xcode project, no package manifest: one `swiftc` invocation, a
# plist, and an icon rendered by the `rsvg-convert` recipe AGENTS.md
# already documents for the PNG icons. Everything it needs ships with
# the Command Line Tools apart from rsvg-convert (`brew install
# librsvg`), which this repo already requires.
#
# Run through `pnpm build:mac`, which builds the site first.
# ------------------------------------------------------------------ #
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="$here/build"
app="$out/circal.app"
# Read before anything else touches the positional parameters. The icon loop
# below used `set --` to split its size table and silently ate this: `$1` was
# `1024` by the time the build mode was tested, so `--universal` built one slice.
mode="${1:-}"

[ -f "$root/dist/index.html" ] || {
  echo "mac/build.sh: no dist/index.html — run \`pnpm build\` first" >&2
  exit 1
}
command -v rsvg-convert >/dev/null || {
  echo "mac/build.sh: rsvg-convert not found — \`brew install librsvg\`" >&2
  exit 1
}

rm -rf "$out"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

# The icon. Ten renders rather than one scaled PNG, because the 16px slice is
# the one the mark was tuned at (see public/favicon.svg) and a downscale of the
# 1024 loses the ring to grey.
iconset="$out/circal.iconset"
mkdir -p "$iconset"
while read -r size slice; do
  rsvg-convert -w "$size" -h "$size" "$here/icon.svg" -o "$iconset/icon_$slice.png"
done <<'SIZES'
16 16x16
32 16x16@2x
32 32x32
64 32x32@2x
128 128x128
256 128x128@2x
256 256x256
512 256x256@2x
512 512x512
1024 512x512@2x
SIZES
iconutil -c icns "$iconset" -o "$app/Contents/Resources/circal.icns"
rm -rf "$iconset"

cp "$here/Info.plist" "$app/Contents/Info.plist"
# The webview is served this directory over loopback, so it is the build
# verbatim — service worker, manifest and hashed assets included.
cp -R "$root/dist" "$app/Contents/Resources/dist"

# Host arch by default; `--universal` builds both slices and lipos them, which is
# what a build somebody else runs has to be. Two compiles rather than one
# `-target` pair, because swiftc emits a single-arch object either way.
if [ "$mode" = "--universal" ]; then
  for arch in arm64 x86_64; do
    swiftc \
      -O \
      -swift-version 5 \
      -target "$arch-apple-macos13.0" \
      -framework AppKit -framework WebKit \
      -o "$out/circal-$arch" \
      "$here/main.swift"
  done
  lipo -create -output "$app/Contents/MacOS/circal" "$out/circal-arm64" "$out/circal-x86_64"
  rm -f "$out/circal-arm64" "$out/circal-x86_64"
else
  swiftc \
    -O \
    -swift-version 5 \
    -target "$(uname -m)-apple-macos13.0" \
    -framework AppKit -framework WebKit \
    -o "$app/Contents/MacOS/circal" \
    "$here/main.swift"
fi

# Ad-hoc by default: enough to launch a locally built app, and nothing a second
# machine will accept. Handing this to somebody else means a Developer ID and
# notarisation instead — `CIRCAL_SIGN_ID` switches to that, and APP.md's
# "handing it to somebody else" section is the rest of the recipe.
if [ -n "${CIRCAL_SIGN_ID:-}" ]; then
  codesign --force --deep --timestamp --options runtime \
    --sign "$CIRCAL_SIGN_ID" --identifier app.circal.mac "$app"
else
  codesign --force --sign - --identifier app.circal.mac "$app" >/dev/null
fi

printf 'built %s (%s, %s)\n' "$app" "$(du -sh "$app" | cut -f1)" \
  "$(lipo -archs "$app/Contents/MacOS/circal")"
