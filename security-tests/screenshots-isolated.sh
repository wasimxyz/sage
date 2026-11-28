#!/bin/sh
# make screenshots runs a packaged-mode Sage with automation on. That Sage must
# never open your own journal, share your app's web storage, touch the
# Keychain item your app keeps, or download a model, and neither its
# automation build nor anything it starts may outlive the run.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
runner="$root/scripts/screenshots.sh"
driver="$root/agent/scripts/screenshots.ts"
main_zig="$root/src/main.zig"
runner_zig="$root/src/runner.zig"
code_lines() {
  grep -v '^[[:space:]]*#' "$1"
}

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
# A model name from your shell could point Sage at a model this Mac lacks,
# which the Local AI step would download.
grep -Fq -- '-u SAGE_EMBED_MODEL -u SAGE_SUMMARY_MODEL' "$runner" ||
  fail "scripts/screenshots.sh does not unset SAGE_EMBED_MODEL and SAGE_SUMMARY_MODEL."
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

# The script clears the copy's web storage and caches. Every folder it names
# under ~/Library must carry the copy's bundle id, never your app's, except
# the dev app's folder, which it only reads.
dev_folder_line='dev_data_dir="$HOME/Library/Application Support/com.wasimxyz.sage-dev"'
grep -Fqx "$dev_folder_line" "$runner" ||
  fail "scripts/screenshots.sh does not read the dev journal from the dev app's folder."
if code_lines "$runner" | grep -F 'Library/' | grep -Fv '$shots_bundle_id' |
  grep -Fxv "$dev_folder_line" | grep -q .; then
  fail "scripts/screenshots.sh names a ~/Library folder that is not the copy's or the dev app's."
fi
# Your own journal lives in com.wasimxyz.sage. The script never names it.
if code_lines "$runner" | grep -Eq 'com\.wasimxyz\.sage["/]'; then
  fail "scripts/screenshots.sh names your app's folder."
fi
# The dev journal is only read: a read-only backup of app.db and a copy of the
# memory marker, both into the scratch journal. No other line touches it.
if code_lines "$runner" | grep -E '\$(dev_data_dir|dev_db)' | sed 's/^[[:space:]]*//' |
  grep -Fxv 'dev_db="$dev_data_dir/app.db"' |
  grep -Fxv '[ -f "$dev_db" ] ||' |
  grep -Fxv "sqlite3 -readonly \"\$dev_db\" \".backup '\$data_dir/app.db'\"" |
  grep -Fxv 'if [ -f "$dev_data_dir/.memory-feature-mode" ]; then' |
  grep -Fxv 'cp "$dev_data_dir/.memory-feature-mode" "$data_dir/.memory-feature-mode"' |
  grep -q .; then
  fail "scripts/screenshots.sh does more with the dev journal than read it."
fi
# Every other sqlite3 call writes only the copy.
if code_lines "$runner" | grep -F 'sqlite3 ' | grep -Fv 'sqlite3 -readonly "$dev_db"' |
  grep -Fv 'sqlite3 "$data_dir/app.db"' | grep -Fv 'for cmd in' | grep -q .; then
  fail "scripts/screenshots.sh runs sqlite3 on a database that is not the copy."
fi
backup_line=$(grep -n 'sqlite3 -readonly "$dev_db"' "$runner" | head -n 1 | cut -d: -f1)
[ -n "$backup_line" ] && [ "$backup_line" -lt "$(grep -n 'SAGE_DATA_DIR="$data_dir"' "$runner" | head -n 1 | cut -d: -f1)" ] ||
  fail "scripts/screenshots.sh does not copy the dev journal before Sage starts."
# Everything it deletes is the copy's storage, the scratch folder, or the build.
if code_lines "$runner" | grep -F 'rm -rf' |
  grep -Fv '$shots_bundle_id' | grep -Fv '"$work"' | grep -Fv '"$build"' | grep -q .; then
  fail "scripts/screenshots.sh deletes something that is not the copy's."
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
if code_lines "$runner" | grep -Eq 'zig-out/(bin|package)'; then
  fail "scripts/screenshots.sh writes to zig-out/bin or zig-out/package."
fi
# Ollama and Chat outlive a crashed copy, so cleanup stops them before it
# deletes the build they run from.
stop_line=$(grep -n '^  stop_copy_processes$' "$runner" | head -n 1 | cut -d: -f1)
build_rm_line=$(grep -n '^  rm -rf "$build"$' "$runner" | head -n 1 | cut -d: -f1)
[ -n "$stop_line" ] && [ -n "$build_rm_line" ] && [ "$stop_line" -lt "$build_rm_line" ] ||
  fail "scripts/screenshots.sh does not stop what the copy started before it deletes the build."

# Turning Touch ID or the lock off deletes a Keychain item, and a pull fills
# the ~/.ollama your own Sage uses. Nothing in the driver may do either, save
# or delete an entry or a chat, or delete data.
for forbidden in journal.save journal.delete chat.save chat.delete lock.disable lock.removePassword encryption. data.delete ollama.pull ollama.delete; do
  if grep -Fq "\"$forbidden" "$driver"; then
    fail "agent/scripts/screenshots.ts names $forbidden."
  fi
done

# A journal in SAGE_DATA_DIR keeps its Touch ID key under a Keychain service
# of its own, so no Keychain call may name the app id directly.
if grep -Eq 'keychain\.(storeKey|readKey|deleteKey)\(self\.app_id' "$main_zig"; then
  fail "src/main.zig names the app id as the Keychain service, which a scratch journal shares."
fi
grep -Fq 'dataDirKeychainService(std.heap.page_allocator, init.environ_map, app_id)' "$main_zig" ||
  fail "src/main.zig does not give a journal in SAGE_DATA_DIR its own Keychain service."

# The route, appearance, and zoom commands only exist in automation builds: the one
# call that reads them sits right inside the automation branch, and each
# handler has one caller.
gate_line=$(grep -n '} else if (build_options.automation) {' "$main_zig" | cut -d: -f1)
parse_lines=$(grep -n 'parseAutomationCommand(command\.name)' "$main_zig" | cut -d: -f1)
[ -n "$gate_line" ] && [ "$(echo "$gate_line" | wc -l)" -eq 1 ] ||
  fail "src/main.zig does not have one automation branch for native commands."
[ "$parse_lines" = "$((gate_line + 1))" ] ||
  fail "src/main.zig reads app.route, app.appearance, and app.zoom outside its automation branch."
[ "$(grep -c 'try emitAutomationRoute(' "$main_zig")" -eq 1 ] ||
  fail "src/main.zig opens an automation route from more than one place."
[ "$(grep -c 'window_chrome\.setAppearance(' "$main_zig")" -eq 1 ] ||
  fail "src/main.zig sets the appearance from more than one place."
[ "$(grep -c 'window_chrome\.setPageZoom(' "$main_zig")" -eq 1 ] ||
  fail "src/main.zig zooms the page from more than one place."

# The cleanup that stops a crashed copy's processes must stop only processes
# whose program sits inside the copy's bundle. Run it for real on a fake
# bundle, beside the same program in another bundle, which must keep running.
# `exec -a` gives a real sleep a program path inside each bundle. Each starts
# in a subshell, so launchd reaps it and `kill -0` sees it end.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/screenshots-isolated.XXXXXX")
copy_pid=""
other_pid=""
trap 'kill $copy_pid $other_pid 2>/dev/null || true; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/build/Sage.app" "$tmp/other/Sage.app"
start_fake() {
  (bash -c 'exec -a "$0" /bin/sleep 30' "$1/Sage.app/Contents/Resources/ollama/ollama" \
    >/dev/null 2>&1 &
    echo $! >"$2")
}
start_fake "$tmp/build" "$tmp/copy.pid"
start_fake "$tmp/other" "$tmp/other.pid"
copy_pid=$(cat "$tmp/copy.pid")
other_pid=$(cat "$tmp/other.pid")
sleep 0.5
kill -0 "$copy_pid" 2>/dev/null && kill -0 "$other_pid" 2>/dev/null ||
  fail "The fake processes for the cleanup test did not start."
eval "$(sed -n '/^stop_copy_processes() {/,/^}/p' "$runner")"
command -v stop_copy_processes >/dev/null 2>&1 ||
  fail "scripts/screenshots.sh has no stop_copy_processes."
build="$tmp/build"
stop_copy_processes 2>/dev/null
sleep 0.3
if kill -0 "$copy_pid" 2>/dev/null; then
  fail "stop_copy_processes left a process from the copy's bundle running."
fi
kill -0 "$other_pid" 2>/dev/null ||
  fail "stop_copy_processes stopped a process from another bundle."
kill "$other_pid" 2>/dev/null || true

# Automation builds never check for updates at launch, so no sheet covers the
# window the script captures.
grep -Fq 'checksForUpdatesOnStart(app_manifest.updates.check_on_start, build_options.automation)' "$runner_zig" ||
  fail "src/runner.zig checks for updates at launch in automation builds."

# Window state follows SAGE_DATA_DIR, so the copy never moves your app's window.
grep -Fq 'env_map.get("SAGE_DATA_DIR")' "$runner_zig" ||
  fail "src/runner.zig keeps the window state under the app id even with SAGE_DATA_DIR set."

echo "screenshots-isolated tests passed"
