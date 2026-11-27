#!/bin/sh
# Copy the eve self-host trio, a pinned Node.js, a pinned Ollama CLI, and the
# speech library into a packaged Sage.app so `eve start`, local AI, and
# dictation run without system installs. Usage:
#   copy-agent-into-app.sh [Sage.app [libSageSpeech.dylib]]
set -eu

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
app="${1:-}"
speech_lib="${2:-$root/zig-out/lib/libSageSpeech.dylib}"

if [ -z "$app" ]; then
  # `native package` writes Sage.app. `zig build package` writes a versioned
  # name and passes it as $1. Picking the newest directory by mtime used to
  # copy the agent into a sibling .app and leave Sage.app on an old CORS list.
  app="$root/zig-out/package/Sage.app"
fi

if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "copy-agent-into-app: no Sage .app bundle found" >&2
  exit 1
fi

src="$root/agent"
dest="$app/Contents/Resources/agent"

if [ ! -d "$src/agent" ] || [ ! -d "$src/.output" ] || [ ! -d "$src/node_modules" ] || [ ! -f "$src/package.json" ]; then
  echo "copy-agent-into-app: build the agent first with npm --prefix agent run build" >&2
  exit 1
fi

mkdir -p "$dest/agent" "$dest/.output" "$dest/node_modules"
rsync -a --delete "$src/agent/" "$dest/agent/"
rsync -a --delete "$src/.output/" "$dest/.output/"
rsync -a --delete "$src/node_modules/" "$dest/node_modules/"

# `make package` installs the agent with --omit=dev, so these trees hold no dev
# modules. Fail instead of shipping them if one comes back.
sh "$root/scripts/refuse-packaged-dev-modules.sh" "$dest/node_modules" "$dest/.output/server/node_modules"

cp "$src/package.json" "$dest/package.json"

# `file:` dependencies install as symlinks into this repo. After rsync, that
# symlink is dangling inside the bundle (`../../packages/...` points outside
# Contents/Resources). Copy the real package from the source tree instead.
world_src="$src/packages/world-encrypted-local"
world_dest="$dest/node_modules/@sage/world-encrypted-local"
if [ -d "$world_src" ]; then
  rm -rf "$world_dest"
  mkdir -p "$dest/node_modules/@sage"
  rsync -a --delete "$world_src/" "$world_dest/"
fi

sh "$root/scripts/fetch-node.sh" "$app"
sh "$root/scripts/fetch-ollama.sh" "$app"

# Dictation's speech engine is a separate library for macOS 26 and later. Sage
# loads it from Contents/Frameworks and never links it, so an older Mac simply
# hides the mic. `make build` or `make package` builds it with the app.
if [ ! -f "$speech_lib" ]; then
  echo "copy-agent-into-app: no speech library at $speech_lib; build it first with make build" >&2
  exit 1
fi
mkdir -p "$app/Contents/Frameworks"
cp "$speech_lib" "$app/Contents/Frameworks/libSageSpeech.dylib"

# The package command writes its own microphone prompt, which says "recording".
# Replace it before signing, because editing the plist breaks the seal. Add the
# key if the package command left it out.
mic_text="Sage listens only while you dictate. Audio stays on this Mac and is never saved."
plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $mic_text" "$plist" 2>/dev/null ||
  /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string $mic_text" "$plist"

channel="$dest/agent/channels/eve.ts"
if ! grep -q 'origin: "zero://app"' "$channel" || ! grep -q 'allowedHeaders: "*"' "$channel"; then
  echo "copy-agent-into-app: packaged Chat CORS is missing the zero://app policy" >&2
  exit 1
fi

# Copying into Contents/Resources breaks an earlier codesign seal. Re-sign
# ad-hoc so a local .app still launches on Apple silicon.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$app"
fi

echo "Copied Chat agent into $dest"
