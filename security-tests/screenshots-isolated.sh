#!/bin/sh
# make screenshots runs a packaged-mode Sage with automation on. That Sage must
# never open your own journal, share your app's web storage, or touch the
# Keychain item your app keeps, and its automation build must not outlive the
# run.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
runner="$root/scripts/screenshots.sh"
driver="$root/agent/scripts/screenshots.ts"
main_zig="$root/src/main.zig"
runner_zig="$root/src/runner.zig"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$runner" ] || fail "missing scripts/screenshots.sh"
[ -f "$driver" ] || fail "missing agent/scripts/screenshots.ts"

# Packaged mode opens com.wasimxyz.sage, your journal, unless SAGE_DATA_DIR
# names another folder. The script must set it to a folder inside a fresh
# mktemp folder, and must not run in dev mode or against a dev frontend.
grep -Fq 'work=$(mktemp -d' "$runner" ||
  fail "scripts/screenshots.sh does not make a fresh scratch folder."
grep -Fq 'data_dir="$work/data"' "$runner" ||
  fail "scripts/screenshots.sh does not keep the journal inside the scratch folder."
grep -Fq 'SAGE_DATA_DIR="$data_dir"' "$runner" ||
  fail "scripts/screenshots.sh does not start Sage with SAGE_DATA_DIR set to the scratch journal."
grep -Fq -- '-u NATIVE_SDK_MODE' "$runner" ||
  fail "scripts/screenshots.sh does not unset NATIVE_SDK_MODE."
grep -Fq -- '-u NATIVE_SDK_FRONTEND_URL' "$runner" ||
  fail "scripts/screenshots.sh does not unset NATIVE_SDK_FRONTEND_URL."
mkdir_line=$(grep -n 'work=$(mktemp -d' "$runner" | head -n 1 | cut -d: -f1)
launch_line=$(grep -n 'SAGE_DATA_DIR="$data_dir"' "$runner" | head -n 1 | cut -d: -f1)
[ "$mkdir_line" -lt "$launch_line" ] ||
  fail "scripts/screenshots.sh starts Sage before it makes the scratch folder."

# A bundle id of its own keeps the copy's WebKit storage out of
# ~/Library/WebKit/com.wasimxyz.sage. It is set before the copy script signs.
grep -Fq 'shots_bundle_id="com.wasimxyz.sage.screenshots"' "$runner" ||
  fail "scripts/screenshots.sh does not give the app its own bundle id."
plist_line=$(grep -n 'Set :CFBundleIdentifier $shots_bundle_id' "$runner" | head -n 1 | cut -d: -f1)
sign_line=$(grep -n 'copy-agent-into-app.sh" "$app"' "$runner" | head -n 1 | cut -d: -f1)
[ -n "$plist_line" ] && [ -n "$sign_line" ] ||
  fail "scripts/screenshots.sh does not change the bundle id or does not run copy-agent-into-app.sh."
[ "$plist_line" -lt "$sign_line" ] ||
  fail "scripts/screenshots.sh changes the bundle id after the app is signed, which breaks the seal."

# The script clears the copy's web storage and caches. Every folder it deletes
# under ~/Library must carry the copy's bundle id, never your app's.
if grep -v '^[[:space:]]*#' "$runner" | grep -F 'Library/' | grep -Fv '$shots_bundle_id' | grep -q .; then
  fail "scripts/screenshots.sh names a ~/Library folder that is not the copy's."
fi

# The automation build lives under its own folder and is deleted on the way out.
grep -Fq 'build="$root/zig-out/screenshots-build"' "$runner" ||
  fail "scripts/screenshots.sh does not build under zig-out/screenshots-build."
grep -Fq 'native build -Dinstall-prefix="$build" -Dautomation=true' "$runner" ||
  fail "scripts/screenshots.sh does not install the automation build under \$build."
grep -Fq 'native package --target macos --binary "$build/bin/Sage" --output "$build/Sage.app"' "$runner" ||
  fail "scripts/screenshots.sh does not package into \$build."
grep -Fq 'rm -rf "$build"' "$runner" ||
  fail "scripts/screenshots.sh does not delete the automation build."
grep -F 'cleanup' "$runner" | grep -Fq 'trap' ||
  fail "scripts/screenshots.sh does not clean up on the way out."
if grep -v '^[[:space:]]*#' "$runner" | grep -Eq 'zig-out/(bin|package)'; then
  fail "scripts/screenshots.sh writes to zig-out/bin or zig-out/package."
fi

# The Keychain item is named after the real app id, and turning Touch ID or
# the lock off deletes it. Nothing in the driver may do that, or delete data.
for forbidden in lock.disable lock.removePassword encryption. data.delete; do
  if grep -Fq "\"$forbidden" "$driver"; then
    fail "agent/scripts/screenshots.ts names $forbidden."
  fi
done

# The route and appearance commands only exist in automation builds.
grep -Fq '} else if (build_options.automation) {' "$main_zig" ||
  fail "src/main.zig handles app.route and app.appearance outside an automation build."

# Window state follows SAGE_DATA_DIR, so the copy never moves your app's window.
grep -Fq 'env_map.get("SAGE_DATA_DIR")' "$runner_zig" ||
  fail "src/runner.zig keeps the window state under the app id even with SAGE_DATA_DIR set."

echo "screenshots-isolated tests passed"
