#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script="$root/scripts/reset-dev.sh"

fail() {
  echo "$1" >&2
  exit 1
}

work=$(mktemp -d "${TMPDIR:-/tmp}/sage-reset-dev-test.XXXXXX")
cleanup() {
  rm -rf "$work"
}
trap cleanup EXIT

home="$work/home"
repo="$work/repo"
stubs="$work/stubs"
elsewhere="$work/elsewhere"
keychain_item="$work/keychain-item"
security_log="$work/security.log"
dev_data="$home/Library/Application Support/com.wasimxyz.sage-dev"
packaged_data="$home/Library/Application Support/com.wasimxyz.sage"

# Stubs stand in for the real tools, so the test never looks at running
# processes, the network, or the login keychain.
mkdir -p "$stubs"
cat >"$stubs/lsof" <<'EOF'
#!/bin/sh
[ -n "${STUB_LSOF_PIDS:-}" ] || exit 1
printf '%s\n' $STUB_LSOF_PIDS
EOF
cat >"$stubs/curl" <<'EOF'
#!/bin/sh
[ "${STUB_CURL_OK:-}" = 1 ] || exit 7
EOF
cat >"$stubs/security" <<'EOF'
#!/bin/sh
echo "$*" >>"$STUB_SECURITY_LOG"
case $1 in
  find-generic-password) [ -e "$STUB_KEYCHAIN_ITEM" ] ;;
  delete-generic-password) rm -f "$STUB_KEYCHAIN_ITEM" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$stubs/lsof" "$stubs/curl" "$stubs/security"

seed() {
  rm -rf "$home" "$repo" "$elsewhere"
  mkdir -p \
    "$dev_data/State" \
    "$dev_data/eve/.eve/.workflow-data" \
    "$packaged_data" \
    "$repo/agent/.eve/.workflow-data/wrun_1" \
    "$repo/agent/.eve/dev-runtime" \
    "$home/Library/WebKit/Sage/WebsiteData/Default" \
    "$home/Library/WebKit/com.wasimxyz.sage" \
    "$home/Library/Caches/Sage" \
    "$home/Library/Caches/com.wasimxyz.sage" \
    "$home/Library/HTTPStorages" \
    "$home/Library/Preferences" \
    "$elsewhere"
  touch \
    "$dev_data/app.db" \
    "$packaged_data/app.db" \
    "$home/Library/HTTPStorages/Sage.binarycookies" \
    "$home/Library/HTTPStorages/com.wasimxyz.sage.binarycookies" \
    "$home/Library/Preferences/Sage.plist" \
    "$elsewhere/app.db" \
    "$keychain_item"
  : >"$security_log"
}

# Later assignments win, so each case overrides only what it needs.
run_reset() {
  env \
    HOME="$home" \
    PATH="$stubs:$PATH" \
    RESET_DEV_ROOT="$repo" \
    SAGE_DATA_DIR="$elsewhere" \
    STUB_SECURITY_LOG="$security_log" \
    STUB_KEYCHAIN_ITEM="$keychain_item" \
    STUB_LSOF_PIDS= \
    STUB_CURL_OK= \
    YES= \
    "$@" sh "$script" </dev/null 2>&1
}

expect_untouched() {
  [ -e "$dev_data/app.db" ] || fail "$1: expected the dev database to stay"
  [ -e "$repo/agent/.eve/.workflow-data/wrun_1" ] || fail "$1: expected the dev Chat sessions to stay"
  [ -e "$keychain_item" ] || fail "$1: expected the Keychain item to stay"
  if grep -q delete-generic-password "$security_log"; then
    fail "$1: expected no Keychain delete"
  fi
}

seed
if out=$(run_reset); then
  fail "expected a reset with no terminal and no YES=1 to refuse"
fi
case "$out" in
  *"YES=1"*) ;;
  *) fail "expected the refusal to mention YES=1, got: $out" ;;
esac
expect_untouched "no terminal"

seed
if out=$(run_reset YES=1 STUB_LSOF_PIDS=999999); then
  fail "expected a reset to refuse while the dev database is open"
fi
case "$out" in
  *"process 999999"*"Quit Sage"*) ;;
  *) fail "expected the refusal to name the process and say to quit Sage, got: $out" ;;
esac
expect_untouched "database open"

seed
if out=$(run_reset YES=1 STUB_CURL_OK=1); then
  fail "expected a reset to refuse while the Chat agent runs"
fi
case "$out" in
  *"port 2000"*) ;;
  *) fail "expected the refusal to name port 2000, got: $out" ;;
esac
expect_untouched "agent running"

seed
out=$(run_reset YES=1) || fail "expected YES=1 to reset, got: $out"
case "$out" in
  *"$dev_data"*"Keychain item journal-data-key (com.wasimxyz.sage-dev)"*) ;;
  *) fail "expected the reset to list the data dir and the Keychain item, got: $out" ;;
esac
for gone in \
  "$dev_data" \
  "$repo/agent/.eve/.workflow-data" \
  "$home/Library/WebKit/Sage" \
  "$home/Library/Caches/Sage" \
  "$home/Library/HTTPStorages/Sage.binarycookies" \
  "$keychain_item"
do
  [ ! -e "$gone" ] || fail "expected the reset to delete $gone"
done
grep -qx "delete-generic-password -s com.wasimxyz.sage-dev -a journal-data-key" "$security_log" ||
  fail "expected the reset to delete only the dev Keychain item, got: $(cat "$security_log")"
for kept in \
  "$packaged_data/app.db" \
  "$home/Library/WebKit/com.wasimxyz.sage" \
  "$home/Library/Caches/com.wasimxyz.sage" \
  "$home/Library/HTTPStorages/com.wasimxyz.sage.binarycookies" \
  "$home/Library/Preferences/Sage.plist" \
  "$repo/agent/.eve/dev-runtime" \
  "$elsewhere/app.db"
do
  [ -e "$kept" ] || fail "expected the reset to keep $kept"
done

: >"$security_log"
out=$(run_reset) || fail "expected a second reset to succeed with nothing to do, got: $out"
case "$out" in
  *"Nothing to reset"*) ;;
  *) fail "expected a second reset to say there is nothing to reset, got: $out" ;;
esac
if grep -q delete-generic-password "$security_log"; then
  fail "expected a second reset to skip the Keychain delete"
fi

echo "reset-dev: ok"
