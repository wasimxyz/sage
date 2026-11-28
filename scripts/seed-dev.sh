#!/bin/sh
# Reset the dev app and fill its journal with the entries in scripts/seed,
# moved by whole weeks so the newest is in the last 7 days. SEED names another
# folder of entries, such as an eval person: SEED=agent/evals/content/data/people/<id>.
# Only its top-level .md files are entries. Only the dev app: the packaged app's
# data is never touched. Ollama and its models stay. Dream does not run, and no
# chats are made.
#
# CHATS=1 also holds the chats in the folder's chats.yaml with the real Chat
# agent on qwen3.5:9b, Dream before and after. Ben's side is played by the same
# local model. It takes 15 to 35 minutes.
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

case ${CHATS:-} in
  "" | 0) chats=0 ;;
  1) chats=1 ;;
  *) fail "CHATS is ${CHATS}. Use CHATS=1, or leave it out." ;;
esac

# The chats need both of Sage's models. The dev app's Ollama reads the same
# models folder, OLLAMA_MODELS when it is set.
if [ "$chats" = 1 ]; then
  library="${OLLAMA_MODELS:-$HOME/.ollama/models}/manifests/registry.ollama.ai/library"
  [ -f "$library/qwen3.5/9b" ] ||
    fail "CHATS=1 needs qwen3.5:9b. Download it in Sage under Settings > Models, then run make seed-dev again. Nothing was deleted."
  case $(ls "$library/nomic-embed-text" 2>/dev/null) in
    "") fail "CHATS=1 needs nomic-embed-text. Download it in Sage under Settings > Models, then run make seed-dev again. Nothing was deleted." ;;
  esac
fi

# Read the seed files before anything is built or deleted, so a bad file never
# leaves a wiped dev app. The parser lives in the agent's node_modules.
if [ ! -d "$agent/node_modules" ]; then
  npm --prefix "$agent" install
fi
SAGE_SEED_CHATS="$chats" SAGE_SEED_DIR="$seed_dir" node --experimental-strip-types "$agent/scripts/seed-dev.ts" --check ||
  fail "Fix the seed files, then run make seed-dev again. Nothing was deleted."

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

# reset-dev.sh refuses while the dev app or the Chat agent is running, and asks
# first. It exits with status 3 when you say no.
reset_status=0
RESET_DEV_DECLINED_STATUS=3 YES="${YES:-}" sh "$root/scripts/reset-dev.sh" || reset_status=$?
case $reset_status in
  0) ;;
  3)
    echo "Nothing seeded."
    exit 0
    ;;
  *) exit "$reset_status" ;;
esac
echo "Seeding the fresh dev app."

# The scratch folder is the app's working directory. It holds a blank page for
# the window and the automation files. With SAGE_DATA_DIR unset, the dev app
# opens its own data folder, so the next `make dev` finds the entries.
# SAGE_DEV_EVE_WORKFLOW_DIR is what `make dev` sets. Without it, a dev app that
# starts with memory off cannot finish switching memory off, and it leaves the
# memory marker half done.
work=$(mktemp -d "${TMPDIR:-/tmp}/sage-seed.XXXXXX")
mkdir -p "$work/frontend/dist"
printf '%s\n' '<!doctype html><html><head><meta charset="utf-8"><title>Sage seed</title></head><body></body></html>' >"$work/frontend/dist/index.html"
ln -s "$root/app.json" "$work/app.json"

echo "Starting Sage"
(
  cd "$work"
  exec env -u SAGE_DATA_DIR -u NATIVE_SDK_FRONTEND_URL \
    SAGE_DEV_EVE_WORKFLOW_DIR="$root/agent/.eve/.workflow-data" \
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

# The Chat agent reads the token in the dev app's own agent-server.json. Named
# here, it never falls back to the packaged app's.
SAGE_AUTOMATION_CWD="$work" SAGE_SEED_DIR="$seed_dir" SAGE_SEED_CHATS="$chats" \
  SAGE_DISCOVERY_FILE="$data_dir/agent-server.json" \
  node --experimental-strip-types "$agent/scripts/seed-dev.ts"

if [ "$chats" = 1 ]; then
  echo "Seeded the dev app with entries, Dream, and chats. Run make dev to open it."
else
  echo "Seeded the dev app. Run make dev to open it, then start Dream from the sidebar."
fi
