#!/bin/sh
# Build the ZIP the in-app updater downloads from a Sage .app that already
# contains the Chat agent and Node. `native package --update-archive` snapshots
# the bundle before copy-agent-into-app.sh runs, so its ZIP would ship without
# the agent. This uses the same `ditto` command, on the finished bundle.
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
app="${1:-}"

if [ -z "$app" ]; then
  app="$root/zig-out/package/Sage.app"
fi

if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "update-archive-packaged-app: no Sage .app bundle found" >&2
  exit 1
fi

if [ ! -d "$app/Contents/Resources/agent/.output" ] || [ ! -x "$app/Contents/Resources/node/bin/node" ]; then
  echo "update-archive-packaged-app: $app has no Chat agent or Node; run copy-agent-into-app.sh first" >&2
  exit 1
fi

version="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")"
out="$root/zig-out/package/Sage-$version-macos-update.zip"

rm -f "$out"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$out"
echo "Created $out"
