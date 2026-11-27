#!/bin/sh
# make seed-dev must reset and fill the dev app only, and must not leave an
# automation-enabled binary at zig-out/bin/Sage.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
runner="$root/scripts/seed-dev.sh"
makefile="$root/Makefile"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$runner" ] || fail "missing scripts/seed-dev.sh"

# The dev app's id and no other. The packaged app's id is a prefix of it, so a
# match on the id followed by anything but "-dev" is the packaged journal.
grep -Fq 'app_id="com.wasimxyz.sage-dev"' "$runner" ||
  fail "scripts/seed-dev.sh does not name the dev app id."
if grep -Eq 'com\.wasimxyz\.sage([^-]|$)' "$runner"; then
  fail "scripts/seed-dev.sh names an app id other than the dev app's."
fi

# Dev mode picks that id, and the app only opens the folder SAGE_DATA_DIR
# names when it is set.
grep -Fq 'NATIVE_SDK_MODE=dev' "$runner" ||
  fail "scripts/seed-dev.sh does not launch Sage with NATIVE_SDK_MODE=dev."
grep -Fq -- '-u SAGE_DATA_DIR' "$runner" ||
  fail "scripts/seed-dev.sh does not unset SAGE_DATA_DIR, so a leftover value could point it at another journal."
# Without the dev Chat sessions folder, a dev app that starts with memory off
# stops partway through switching memory off.
grep -Fq 'SAGE_DEV_EVE_WORKFLOW_DIR="$root/agent/.eve/.workflow-data"' "$runner" ||
  fail "scripts/seed-dev.sh does not give the app the dev Chat sessions folder, as make dev does."

# The reset runs before Sage starts, and the seed files are read and the build
# runs before the reset.
check_line=$(grep -n -- 'seed-dev.ts" --check' "$runner" | head -n 1 | cut -d: -f1)
build_line=$(grep -n 'native build' "$runner" | head -n 1 | cut -d: -f1)
reset_line=$(grep -n 'scripts/reset-dev.sh' "$runner" | head -n 1 | cut -d: -f1)
launch_line=$(grep -n 'NATIVE_SDK_MODE=dev' "$runner" | head -n 1 | cut -d: -f1)
[ -n "$check_line" ] && [ -n "$build_line" ] && [ -n "$reset_line" ] && [ -n "$launch_line" ] ||
  fail "scripts/seed-dev.sh is missing the seed check, the build, the reset, or the launch."
[ "$check_line" -lt "$reset_line" ] ||
  fail "scripts/seed-dev.sh resets before it reads the seed files, so a bad file leaves a wiped dev app."
[ "$build_line" -lt "$reset_line" ] ||
  fail "scripts/seed-dev.sh resets before it builds, so a failed build leaves a wiped dev app."
[ "$reset_line" -lt "$launch_line" ] ||
  fail "scripts/seed-dev.sh starts Sage before it resets the dev app."

# With CHATS=1, the chats file and the models are checked before the reset
# too, and the Chat agent gets the dev app's own agent-server.json. Without
# it, the agent falls back to the packaged app's file and reads your journal.
models_line=$(grep -n 'manifests/registry.ollama.ai/library' "$runner" | head -n 1 | cut -d: -f1)
[ -n "$models_line" ] && [ "$models_line" -lt "$reset_line" ] ||
  fail "scripts/seed-dev.sh does not check the models before it resets the dev app."
grep -Fq 'SAGE_SEED_CHATS="$chats" SAGE_SEED_DIR="$seed_dir" node --experimental-strip-types "$agent/scripts/seed-dev.ts" --check' "$runner" ||
  fail "scripts/seed-dev.sh does not check chats.yaml with the seed files."
grep -Fq 'SAGE_DISCOVERY_FILE="$data_dir/agent-server.json"' "$runner" ||
  fail "scripts/seed-dev.sh does not name the dev app's agent-server.json for the Chat agent."

# The chats stay on this Mac: the seed's chat code reaches no cloud model.
chats_code="$root/agent/scripts/seed-dev-chats.ts"
[ -f "$chats_code" ] || fail "missing agent/scripts/seed-dev-chats.ts"
for name in simulated-user grader prices gateway AI_GATEWAY openai anthropic; do
  if grep -Fiq "$name" "$chats_code"; then
    fail "agent/scripts/seed-dev-chats.ts mentions $name. Seeded chats use only the local Ollama."
  fi
done

# The automation build lives under its own prefix and is deleted on the way out.
grep -Fq 'seed_prefix="$root/zig-out/seed"' "$runner" ||
  fail "scripts/seed-dev.sh does not install the automation build under zig-out/seed."
grep -Fq 'native build -Dinstall-prefix="$seed_prefix" -Dautomation=true' "$runner" ||
  fail "scripts/seed-dev.sh does not build the automation binary under \$seed_prefix."
grep -Fq 'binary="$seed_prefix/bin/Sage"' "$runner" ||
  fail "scripts/seed-dev.sh does not launch \$seed_prefix/bin/Sage."
grep -Fq 'rm -rf "$seed_prefix"' "$runner" ||
  fail "scripts/seed-dev.sh does not delete the automation install."
grep -F 'cleanup' "$runner" | grep -Fq 'trap' ||
  fail "scripts/seed-dev.sh does not clean up on the way out."
if grep -Fq 'zig-out/bin/Sage' "$runner"; then
  fail "scripts/seed-dev.sh references zig-out/bin/Sage."
fi

# make dev, make build, and make package never get an automation build.
if grep -Fq -- '-Dautomation' "$makefile"; then
  fail "The Makefile builds with -Dautomation. Only scripts/seed-dev.sh, the eval runner (agent/scripts/eval/sage.ts), and scripts/screenshots.sh may."
fi

echo "seed-dev-dev-only tests passed"
