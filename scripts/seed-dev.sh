#!/bin/sh
# Reset the dev app, fill its journal with the entries in scripts/seed, and run
# Dream. Only the dev app: the packaged app's data is never touched. Ollama and
# its models stay.
#
# The entries go in through the app's own bridge, because only the app opens
# the database. So this builds a throwaway automation binary, starts it as the
# dev app from a scratch folder with a blank page, and drives it the way
# `make eval` does.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
agent="$root/agent"
app_id="com.wasimxyz.sage-dev"

fail() {
  echo "$1" >&2
  exit 1
}

case ${HOME:-} in
  /?*) ;;
  *) fail "HOME is not set to an absolute path." ;;
esac
data_dir="$HOME/Library/Application Support/$app_id"

seed_dir=${SEED:-$root/scripts/seed}
seed_dir=$(CDPATH= cd -- "$seed_dir" 2>/dev/null && pwd) ||
  fail "SEED is not a folder: ${SEED:-$root/scripts/seed}"
case $(ls "$seed_dir"/*.md 2>/dev/null) in
  "") fail "No .md files in $seed_dir." ;;
esac

for cmd in curl native node; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing $cmd."
done

# Fail on Ollama before anything is deleted. Sage matches model names by
# prefix, so this does too.
summary_model=${SAGE_SUMMARY_MODEL:-qwen3.5:9b}
embed_model=${SAGE_EMBED_MODEL:-nomic-embed-text}
tags=$(curl -sf --max-time 2 http://127.0.0.1:11434/api/tags) ||
  fail "Ollama is not running at http://127.0.0.1:11434. Start it, then run make seed-dev again."
tags=$(printf '%s' "$tags" | tr -d ' \n')
for model in "$summary_model" "$embed_model"; do
  case $tags in
    *"\"name\":\"$model"*) ;;
    *) fail "The model $model is not pulled. Run: ollama pull $model" ;;
  esac
done

work=""
sage_pid=""
seed_prefix="$root/zig-out/seed"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$sage_pid" ]; then
    kill "$sage_pid" 2>/dev/null || true
    wait "$sage_pid" 2>/dev/null || true
    # A clean stop removes this itself. A killed one leaves a dead socket and
    # an old token behind in the dev data folder.
    rm -f "$data_dir/agent-server.json"
    if [ "$status" -ne 0 ] && [ -f "$work/sage.log" ]; then
      echo "Sage log:" >&2
      cat "$work/sage.log" >&2 || true
    fi
  fi
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
  rm -rf "$seed_prefix"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Build first, so a failed build never leaves a wiped dev app. The binary goes
# under zig-out/seed, so the one `make dev` and `make build` write never
# becomes an automation build.
# SAGE_MEMORY matches `make dev`: a different setting would redo the memory
# build the next time the dev app starts.
rm -rf "$seed_prefix"
cd "$root"
native build -Dinstall-prefix="$seed_prefix" -Dautomation=true -Dmemory="${SAGE_MEMORY:-false}" -Doptimize=Debug
binary="$seed_prefix/bin/Sage"
[ -x "$binary" ] || fail "Sage was not built at $binary."

if [ ! -d "$agent/node_modules" ]; then
  npm --prefix "$agent" install
fi

# reset-dev.sh refuses while the dev app or the Chat agent is running, and asks
# first. If it asked and you said no, the data folder is still there.
YES="${YES:-}" sh "$root/scripts/reset-dev.sh"
if [ -e "$data_dir" ]; then
  echo "Nothing seeded."
  exit 0
fi
echo "Seeding the fresh dev app."

# The scratch folder is the app's working directory. It holds a blank page for
# the window and the automation files. With SAGE_DATA_DIR unset, the dev app
# opens its own data folder, so the next `make dev` finds the entries.
work=$(mktemp -d "${TMPDIR:-/tmp}/sage-seed.XXXXXX")
mkdir -p "$work/frontend/dist"
printf '%s\n' '<!doctype html><html><head><meta charset="utf-8"><title>Sage seed</title></head><body></body></html>' >"$work/frontend/dist/index.html"
ln -s "$root/app.json" "$work/app.json"

echo "Starting Sage"
(
  cd "$work"
  exec env -u SAGE_DATA_DIR -u NATIVE_SDK_FRONTEND_URL \
    NATIVE_SDK_MODE=dev "$binary" >"$work/sage.log" 2>&1
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

SAGE_AUTOMATION_CWD="$work" SAGE_SEED_DIR="$seed_dir" \
  node --experimental-strip-types "$agent/scripts/seed-dev.ts"

echo "Seeded the dev app. Run make dev to open it."
