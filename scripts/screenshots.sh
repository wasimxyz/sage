#!/bin/sh
# Capture the packaged app's screens, in light and dark, for the website and
# the docs. Builds a throwaway Sage.app with automation on, starts it on a
# scratch journal, fills it with scripts/seed and a written chat, and saves
# one PNG per screen and appearance in zig-out/screenshots (or OUT).
#
# Your own journal is never opened: the app always gets a SAGE_DATA_DIR inside
# a fresh scratch folder, and a bundle id of its own, so its web storage is
# apart too. Ollama and its models in ~/.ollama are shared, as they are for
# every Sage.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
agent="$root/agent"
build="$root/zig-out/screenshots-build"
out="${OUT:-$root/zig-out/screenshots}"
seed_dir="$root/scripts/seed"
shots_bundle_id="com.wasimxyz.sage.screenshots"
optimize="${NATIVE_OPTIMIZE:-ReleaseSafe}"

fail() {
  echo "$1" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "make screenshots runs on macOS only."
for cmd in lsof native node npm swiftc; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing $cmd."
done
[ -x /usr/sbin/screencapture ] || fail "Missing /usr/sbin/screencapture."

# A packaged Sage runs its Ollama on 11435 and Chat on 2001. The copy built
# here does too, so it cannot start beside a Sage that is already open.
for port in 11435 2001; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Port $port is in use. Quit Sage, then run make screenshots again."
  fi
done

work=""
sage_pid=""
agent_pruned=""

# The copy's web storage and caches, kept by macOS under its own bundle id.
# Clearing them before and after each run keeps runs the same.
clear_copy_storage() {
  rm -rf "$HOME/Library/WebKit/$shots_bundle_id" \
    "$HOME/Library/Caches/$shots_bundle_id" \
    "$HOME/Library/HTTPStorages/$shots_bundle_id" \
    "$HOME/Library/HTTPStorages/$shots_bundle_id.binarycookies"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$sage_pid" ]; then
    kill "$sage_pid" 2>/dev/null || true
    wait "$sage_pid" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -n "$work" ] && [ -f "$work/sage.log" ]; then
    echo "Sage log:" >&2
    tail -n 40 "$work/sage.log" >&2 || true
  fi
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
  rm -rf "$build"
  clear_copy_storage
  if [ -n "$agent_pruned" ]; then
    npm --prefix "$agent" install >/dev/null 2>&1 ||
      echo "Run npm --prefix agent install to put the agent's dev modules back." >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

work=$(mktemp -d "${TMPDIR:-/tmp}/sage-screenshots.XXXXXX")
data_dir="$work/data"
# Packaged Sage opens your real journal when SAGE_DATA_DIR is empty, so make
# sure it names the scratch folder before anything starts.
case $data_dir in
  "$work"/data) ;;
  *) fail "The scratch journal is not inside $work." ;;
esac

# Without Screen Recording access, screencapture saves only the desktop.
swiftc -O -o "$work/window" "$root/scripts/screenshots/window.swift"
"$work/window" preflight

# Read the seed files before the long build, so a bad file stops early.
if [ ! -d "$agent/node_modules" ]; then
  npm --prefix "$agent" install
fi
SAGE_SEED_DIR="$seed_dir" node --experimental-strip-types "$agent/scripts/seed-dev.ts" --check ||
  fail "Fix the seed files, then run make screenshots again."

# The `make package` steps, with automation on and everything under
# zig-out/screenshots-build, so zig-out/bin and zig-out/package stay as they
# are. Memory stays off, as it does in releases.
cd "$root"
rm -rf "$build"
npm --prefix frontend run build
agent_pruned=1
npm --prefix agent install --omit=dev
npm --prefix agent run build
native build -Dinstall-prefix="$build" -Dautomation=true -Dmemory=false -Doptimize="$optimize"
native package --target macos --binary "$build/bin/Sage" --output "$build/Sage.app"
app="$build/Sage.app"
[ -x "$app/Contents/MacOS/Sage" ] || fail "Sage.app was not built at $app."
# Set before copy-agent-into-app.sh, which signs the app again at the end.
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $shots_bundle_id" "$app/Contents/Info.plist"
sh "$root/scripts/copy-agent-into-app.sh" "$app" "$build/lib/libSageSpeech.dylib"
npm --prefix agent install
agent_pruned=""

clear_copy_storage
mkdir -p "$data_dir" "$work/logs" "$out"
# Sage opens at its saved window frame, which lives in the scratch journal.
node --experimental-strip-types "$agent/scripts/screenshots.ts" --window-state "$data_dir/State/windows.zon"
echo "Starting Sage on a scratch journal. Keep your hands off the keyboard and the pointer off the window until it finishes."
(
  cd "$work"
  exec env -u NATIVE_SDK_MODE -u NATIVE_SDK_FRONTEND_URL -u SAGE_OLLAMA_PATH \
    -u SAGE_SPEECH_LIB_PATH -u SAGE_DEV_EVE_WORKFLOW_DIR \
    SAGE_DATA_DIR="$data_dir" NATIVE_SDK_LOG_DIR="$work/logs" \
    "$app/Contents/MacOS/Sage" >"$work/sage.log" 2>&1
) &
sage_pid=$!

i=0
while [ "$i" -lt 300 ]; do
  if [ -d "$work/.zig-cache/native-sdk-automation" ]; then
    break
  fi
  if ! kill -0 "$sage_pid" 2>/dev/null; then
    fail "Sage exited before it was ready."
  fi
  i=$((i + 1))
  sleep 0.1
done
[ -d "$work/.zig-cache/native-sdk-automation" ] || fail "Sage did not create its automation folder."

SAGE_AUTOMATION_CWD="$work" SAGE_SEED_DIR="$seed_dir" SAGE_SCREENSHOTS_OUT="$out" \
  SAGE_SCREENSHOTS_HELPER="$work/window" SAGE_PID="$sage_pid" \
  node --experimental-strip-types "$agent/scripts/screenshots.ts"
