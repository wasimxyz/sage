#!/bin/sh
# held-output.sh must keep a command's exit code and all of its output. If it
# dropped a failing exit code, `make test` would pass with a failing test.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script="$root/scripts/held-output.sh"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$script" ] || fail "missing scripts/held-output.sh"

work=$(mktemp -d "${TMPDIR:-/tmp}/sage-held-output-test.XXXXXX")
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

# A passing command: exit 0, both streams kept, the header first.
status=0
out=$(TMPDIR="$work" sh "$script" sh -c 'echo to-stdout; echo to-stderr >&2') || status=$?
[ "$status" -eq 0 ] || fail "held-output.sh exited $status for a command that passed."
printf '%s\n' "$out" | head -n 1 | grep -Fq '(exit 0, ' ||
  fail "held-output.sh does not start with the command's exit code."
printf '%s\n' "$out" | grep -Fqx 'to-stdout' || fail "held-output.sh lost the command's stdout."
printf '%s\n' "$out" | grep -Fqx 'to-stderr' || fail "held-output.sh lost the command's stderr."

# A failing command keeps its own exit code.
status=0
out=$(TMPDIR="$work" sh "$script" sh -c 'echo broke; exit 3') || status=$?
[ "$status" -eq 3 ] || fail "held-output.sh exited $status for a command that exited 3."
printf '%s\n' "$out" | head -n 1 | grep -Fq '(exit 3, ' ||
  fail "held-output.sh does not report a failing command's exit code."
printf '%s\n' "$out" | grep -Fqx 'broke' || fail "held-output.sh lost a failing command's output."

# A command that cannot start is a failure too.
status=0
TMPDIR="$work" sh "$script" "$work/no-such-command" >/dev/null 2>&1 || status=$?
[ "$status" -ne 0 ] || fail "held-output.sh passed a command that does not exist."

# No command is a usage error.
status=0
TMPDIR="$work" sh "$script" >/dev/null 2>&1 || status=$?
[ "$status" -eq 2 ] || fail "held-output.sh exited $status with no command, not 2."

# The held output never outlives the run.
[ -z "$(ls -A "$work")" ] || fail "held-output.sh left its output file behind."

echo "held-output tests passed"
