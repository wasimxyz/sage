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

# The reset runs before Sage starts, and the build runs before the reset.
build_line=$(grep -n 'native build' "$runner" | head -n 1 | cut -d: -f1)
reset_line=$(grep -n 'scripts/reset-dev.sh' "$runner" | head -n 1 | cut -d: -f1)
launch_line=$(grep -n 'NATIVE_SDK_MODE=dev' "$runner" | head -n 1 | cut -d: -f1)
[ -n "$build_line" ] && [ -n "$reset_line" ] && [ -n "$launch_line" ] ||
  fail "scripts/seed-dev.sh is missing the build, the reset, or the launch."
[ "$build_line" -lt "$reset_line" ] ||
  fail "scripts/seed-dev.sh resets before it builds, so a failed build leaves a wiped dev app."
[ "$reset_line" -lt "$launch_line" ] ||
  fail "scripts/seed-dev.sh starts Sage before it resets the dev app."

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
  fail "The Makefile builds with -Dautomation. Only scripts/seed-dev.sh and scripts/eval-run.sh may."
fi

echo "seed-dev-dev-only tests passed"
