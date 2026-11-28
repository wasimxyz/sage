#!/bin/sh
# Runs a command and holds its output until the command ends, then prints a
# line with the command, its exit code, and its run time, followed by the
# output. `make test` runs its test groups at once through this script, so
# their output never interleaves. Exits with the command's own exit code.
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: sh scripts/held-output.sh command [arg ...]" >&2
  exit 2
fi

log=$(mktemp "${TMPDIR:-/tmp}/sage-held-output.XXXXXX")
cleanup() {
  rm -f "$log"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

start=$(date +%s)
status=0
"$@" >"$log" 2>&1 || status=$?
elapsed=$(($(date +%s) - start))

echo "==> $* (exit $status, ${elapsed}s)"
cat "$log"
exit "$status"
