#!/bin/sh
# Capture the packaged app's screens, in light and dark, for the website and
# the docs. Builds a throwaway Sage.app with automation on, starts it on a
# copy of the dev journal that make seed-dev fills, and saves one PNG per
# screen and appearance in zig-out/screenshots (or OUT). Each entry and each
# chat in that journal gets a shot.
#
# Your own journal is never opened: the app always gets a SAGE_DATA_DIR inside
# a fresh scratch folder, and a bundle id of its own, so its web storage is
# apart too. The dev journal is only read, and the run changes only its copy. Ollama and its models in ~/.ollama are shared, as they are for
# every Sage. The run stops when a model Sage needs is missing, so it never
# starts a download.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
agent="$root/agent"
build="$root/zig-out/screenshots-build"
out="${OUT:-$root/zig-out/screenshots}"
# The dev app's journal, which make seed-dev fills. Read here, never written.
dev_data_dir="$HOME/Library/Application Support/com.wasimxyz.sage-dev"
dev_db="$dev_data_dir/app.db"
shots_bundle_id="com.wasimxyz.sage.screenshots"
optimize="${NATIVE_OPTIMIZE:-ReleaseSafe}"

fail() {
  echo "$1" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "make screenshots runs on macOS only."
for cmd in lsof native node npm sqlite3 swiftc; do
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
  # WebKit and Metal also keep folders under the per-user cache and temp
  # folders in /var/folders.
  for user_dir in "$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null || true)" \
    "$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"; do
    case $user_dir in
      /*/) rm -rf "$user_dir$shots_bundle_id" ;;
    esac
  done
}

# Ollama and Chat run in process groups of their own and do not watch Sage,
# so a copy that crashes leaves them holding 11435 and 2001. Stop anything
# still running from the copy's bundle.
stop_copy_processes() {
  [ -d "$build/Sage.app" ] || return 0
  # The bundle as the script named it, and with symlinks resolved, since a
  # process may show either.
  copy_app="$build/Sage.app/"
  copy_app_real="$(cd "$build" && pwd -P)/Sage.app/"
  for path in "$copy_app" "$copy_app_real"; do
    case $path in
      /?*/Sage.app/) ;;
      *) return 0 ;;
    esac
  done
  # Only processes whose program sits inside the copy's bundle. The paths
  # must reach awk itself: an empty pattern would match every process.
  pids=$(ps -x -U "$(id -u)" -o pid=,command= |
    COPY_APP="$copy_app" COPY_APP_REAL="$copy_app_real" SELF="$$" awk '
      BEGIN {
        app = ENVIRON["COPY_APP"]
        real = ENVIRON["COPY_APP_REAL"]
        if (length(app) < 12 || length(real) < 12) exit 0
      }
      {
        pid = $1
        command = $0
        sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", command)
        if (pid == ENVIRON["SELF"]) next
        if (index(command, app) == 1 || index(command, real) == 1) print pid
      }')
  [ -n "$pids" ] || return 0
  # The copy starts Sage, Ollama and its runners, and Chat. Far more than
  # that means the match is wrong, so stop nothing.
  count=$(echo "$pids" | wc -l | tr -d ' ')
  if [ "$count" -gt 10 ]; then
    echo "Found $count processes that look like the copy's, more than it starts. Not stopping any." >&2
    return 0
  fi
  echo "Stopping what the copy left running:" $pids >&2
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  i=0
  left=$pids
  while [ "$i" -lt 50 ]; do
    still=""
    for pid in $left; do
      if kill -0 "$pid" 2>/dev/null; then
        still="$still $pid"
      fi
    done
    left=$still
    [ -n "$left" ] || return 0
    i=$((i + 1))
    sleep 0.1
  done
  # shellcheck disable=SC2086
  kill -KILL $left 2>/dev/null || true
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$sage_pid" ]; then
    kill "$sage_pid" 2>/dev/null || true
    wait "$sage_pid" 2>/dev/null || true
  fi
  stop_copy_processes
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
# Packaged Sage opens your real journal when SAGE_DATA_DIR is empty, so stop
# unless mktemp made a folder and the journal inside it is new.
if [ -z "$work" ] || [ ! -d "$work" ] || [ -e "$data_dir" ]; then
  fail "Could not make a fresh scratch folder for the journal."
fi

# Without Screen Recording access, screencapture saves only the desktop.
swiftc -O -o "$work/window" "$root/scripts/screenshots/window.swift"
"$work/window" preflight

# Check for the dev journal before the long build.
[ -f "$dev_db" ] ||
  fail "There is no dev journal to capture. Run make seed-dev CHATS=1, then run make screenshots again."
if [ ! -d "$agent/node_modules" ]; then
  npm --prefix "$agent" install
fi

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
# A copy of the dev journal, so nothing the run does reaches it. A backup reads
# one consistent state, even while the dev app is open. The memory marker
# comes too, or Sage would treat the copy as a journal that just turned
# memory off.
sqlite3 -readonly "$dev_db" ".backup '$data_dir/app.db'"
# A chat with a session resumes it when it opens, and the copy's Chat agent
# has none of the dev app's sessions. Without one, a chat opens as its saved
# transcript. Only the copy changes.
sqlite3 "$data_dir/app.db" "UPDATE chat_conversation SET eve_session_id = NULL;"
# Sage skips setup for a journal with entries, and once setup is done it
# can't be reopened. So the copy starts as a setup left half done at Welcome,
# the rows onboarding.save writes, and the shots can step through it.
sqlite3 "$data_dir/app.db" "INSERT INTO app_setting (key, value) VALUES ('onboarding.state', 'active'), ('onboarding.step', 'welcome') ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
if [ -f "$dev_data_dir/.memory-feature-mode" ]; then
  cp "$dev_data_dir/.memory-feature-mode" "$data_dir/.memory-feature-mode"
fi
# Sage opens at its saved window frame, which lives in the scratch journal.
node --experimental-strip-types "$agent/scripts/screenshots.ts" --window-state "$data_dir/State/windows.zon"
echo "Starting Sage on a copy of the dev journal. Keep your hands off the keyboard and the pointer off the window until it finishes."
(
  cd "$work"
  exec env -u NATIVE_SDK_MODE -u NATIVE_SDK_FRONTEND_URL -u SAGE_OLLAMA_PATH \
    -u SAGE_SPEECH_LIB_PATH -u SAGE_DEV_EVE_WORKFLOW_DIR \
    -u SAGE_EMBED_MODEL -u SAGE_SUMMARY_MODEL \
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

SAGE_AUTOMATION_CWD="$work" SAGE_SCREENSHOTS_OUT="$out" \
  SAGE_SCREENSHOTS_HELPER="$work/window" SAGE_PID="$sage_pid" \
  node --experimental-strip-types "$agent/scripts/screenshots.ts"
