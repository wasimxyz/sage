#!/bin/sh
# A launch with SAGE_DATA_DIR must open exactly one app.db, in that directory.
# `make eval` keeps the real $HOME, so a data dir resolved a second time inside
# the runner is the packaged journal path under the real home folder.
#
# The runtime proof lives in the eval run itself: point SAGE_DATA_DIR and HOME
# at throwaway folders, start the built binary, and check that app.db lands
# under SAGE_DATA_DIR while the throwaway HOME stays free of app.db. These
# source checks catch the regression without a build.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
main="$root/src/main.zig"
runner="$root/src/runner.zig"
eval_runner="$root/scripts/eval-run.sh"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$main" ] || fail "missing src/main.zig"
[ -f "$runner" ] || fail "missing src/runner.zig"
[ -f "$eval_runner" ] || fail "missing scripts/eval-run.sh"

# The eval runner hands Sage a throwaway data dir and leaves HOME alone, so the
# override has to reach every open.
grep -Fq 'export SAGE_DATA_DIR="$data_dir"' "$eval_runner" ||
  fail "scripts/eval-run.sh does not export SAGE_DATA_DIR."

# main.zig resolves that dir before it opens the journal, so the call it hands
# to runner.runWithOptions must carry the resolved value instead of letting the
# runner resolve it again. Read the call block, not the whole file: the App
# initializer above assigns its own `.data_dir`, so a bare search for that line
# still passes after the runner's argument is deleted.
run_call=$(awk '/runner\.runWithOptions\(/,/^    \}, init\);/' "$main")
[ -n "$run_call" ] ||
  fail "src/main.zig does not call runner.runWithOptions with an inline options literal."
printf '%s\n' "$run_call" | grep -Fq '.data_dir = data_dir,' ||
  fail "src/main.zig does not pass its resolved data dir to runner.runWithOptions, so the runner resolves the platform data dir itself."

# One open: the journal main.zig opened, with its data dir and migrations
# already applied, is the database the runtime gets.
printf '%s\n' "$run_call" | grep -Fq '.relational_store = app.store.db.binding(),' ||
  fail "src/main.zig does not hand the journal it already opened to runner.runWithOptions, so the runner opens a second app.db."

grep -Fq 'if (options.relational_store == null)' "$runner" ||
  fail "src/runner.zig opens a relational store even when the app already opened one."

grep -Fq 'fn resolveStoreDataDir(' "$runner" ||
  fail "src/runner.zig resolves the store data dir without a helper that honors the app's resolved data dir."

grep -F 'resolveStoreDataDir(' "$runner" | grep -Fq 'options.data_dir' ||
  fail "src/runner.zig opens a store without passing the app's resolved data dir."

# Every data-dir resolution in the runner goes through that helper, so no store
# branch can resolve the platform dir on its own. A raw resolveOne in a store
# branch is the second app.db this file exists to catch.
awk '
  /^fn resolveStoreDataDir\(/ { helper = 1 }
  helper && /^}/ { helper = 0 }
  /native_sdk\.app_dirs\.resolveOne\(/ { calls++; if (helper) honored++ }
  END { exit (calls > 0 && calls == honored) ? 0 : 1 }
' "$runner" ||
  fail "src/runner.zig resolves a data dir outside resolveStoreDataDir, so a store open can ignore the app's resolved data dir."

echo "eval-ignores-data-dir tests passed"
