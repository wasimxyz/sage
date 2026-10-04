#!/bin/sh
# make eval must not leave an automation-enabled binary at zig-out/bin/Sage.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
runner="$root/scripts/eval-run.sh"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$runner" ] || fail "missing scripts/eval-run.sh"

if grep -Fq 'native build -Dautomation=true' "$runner"; then
  fail "scripts/eval-run.sh runs native build -Dautomation=true and leaves zig-out/bin/Sage that way."
fi

grep -Fq 'eval_prefix="$root/zig-out/eval"' "$runner" ||
  fail "scripts/eval-run.sh does not install the eval binary under zig-out/eval."

grep -Fq 'native build -Dinstall-prefix="$eval_prefix" -Dautomation=true' "$runner" ||
  fail "scripts/eval-run.sh does not build the automation binary under \$eval_prefix."

grep -Fq 'binary="$eval_prefix/bin/Sage"' "$runner" ||
  fail "scripts/eval-run.sh does not launch \$eval_prefix/bin/Sage."

grep -Fq 'rm -rf "$eval_prefix"' "$runner" ||
  fail "scripts/eval-run.sh does not delete the eval install."

grep -F 'rm_eval_prefix' "$runner" | grep -Fq 'trap' ||
  fail "scripts/eval-run.sh does not delete the eval install on the way out."

if grep -Fq 'zig-out/bin/Sage' "$runner"; then
  fail "scripts/eval-run.sh still references zig-out/bin/Sage."
fi

grep -Fq '"install-prefix"' "$root/build.zig" ||
  fail "build.zig does not accept -Dinstall-prefix, so the runner cannot redirect its install."

echo "eval-leftover-automation tests passed"
