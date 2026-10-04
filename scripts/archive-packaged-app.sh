#!/bin/sh
# Build a DMG from a Sage .app that already contains the Chat agent and Node.
# `native package --archive` snapshots the bundle before copy-agent-into-app.sh
# runs, so the DMG would ship without the agent.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
app="${1:-}"

if [ -z "$app" ]; then
  app="$root/zig-out/package/Sage.app"
fi

if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "archive-packaged-app: no Sage .app bundle found" >&2
  exit 1
fi

version="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")"
out="$root/zig-out/package/Sage-$version-macos.dmg"
staging="$(mktemp -d "${TMPDIR:-/tmp}/sage-dmg.XXXXXX")"
trap 'rm -rf "$staging"' EXIT

ditto "$app" "$staging/Sage.app"
ln -s /Applications "$staging/Applications"
rm -f "$out"
hdiutil create -volname Sage -format UDZO -srcfolder "$staging" -ov "$out"
echo "Created $out"
