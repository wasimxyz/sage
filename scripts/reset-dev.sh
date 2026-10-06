#!/bin/sh
# Delete everything the dev app keeps, so the next `make dev` opens Sage the
# way a new user sees it. Only the dev app: the packaged app's data
# (com.wasimxyz.sage) is never touched. Ollama and its models stay.
set -eu

root=${RESET_DEV_ROOT:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}
app_id="com.wasimxyz.sage-dev"
keychain_account="journal-data-key"

fail() {
  echo "$1" >&2
  exit 1
}

# Every path is fixed. SAGE_DATA_DIR is ignored on purpose, so this script
# never deletes a folder named by the environment.
case ${HOME:-} in
  /?*) ;;
  *) fail "HOME is not set to an absolute path." ;;
esac
data_dir="$HOME/Library/Application Support/$app_id"

# The data dir holds app.db, the packaged-style eve folder, the memory build
# marker, and window positions. `make dev` keeps Chat sessions in the repo.
# WebKit names its folders after the dev process, which is `Sage`.
dev_paths() {
  printf '%s\n' \
    "$data_dir" \
    "$root/agent/.eve/.workflow-data" \
    "$HOME/Library/WebKit/Sage" \
    "$HOME/Library/Caches/Sage" \
    "$HOME/Library/HTTPStorages/Sage" \
    "$HOME/Library/HTTPStorages/Sage.binarycookies"
}

refuse_while_running() {
  pids=$(lsof -t -- "$data_dir/app.db" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do
      name=$(ps -p "$pid" -o comm= 2>/dev/null || true)
      echo "The dev database is open in process $pid${name:+ ($name)}." >&2
    done
    fail "Quit Sage, then run make reset-dev again."
  fi
  if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:2000/eve/v1/health 2>/dev/null; then
    fail "The Chat agent is running on port 2000. Stop make dev, then run make reset-dev again."
  fi
}

confirm_reset() {
  if [ "${YES:-}" = 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    fail "Not resetting without a terminal. Run make reset-dev YES=1 to skip the prompt."
  fi
  printf 'Delete these for good? [y/N] '
  answer=
  IFS= read -r answer || true
  case $answer in
    y|Y|yes|YES) return 0 ;;
    *)
      echo "Nothing deleted."
      return 1
      ;;
  esac
}

refuse_while_running

existing=$(dev_paths | while IFS= read -r path; do
  if [ -e "$path" ]; then
    printf '%s\n' "$path"
  fi
done)

keychain=false
if security find-generic-password -s "$app_id" -a "$keychain_account" >/dev/null 2>&1; then
  keychain=true
fi

if [ -z "$existing" ] && [ "$keychain" = false ]; then
  echo "Nothing to reset. The dev app already starts fresh."
  exit 0
fi

echo "This deletes the dev app's data:"
if [ -n "$existing" ]; then
  printf '%s\n' "$existing" | sed 's/^/  /'
fi
if [ "$keychain" = true ]; then
  echo "  Keychain item $keychain_account ($app_id)"
fi

if ! confirm_reset; then
  exit 0
fi

printf '%s\n' "$existing" | while IFS= read -r path; do
  [ -z "$path" ] || rm -rf -- "$path"
done

if [ "$keychain" = true ]; then
  security delete-generic-password -s "$app_id" -a "$keychain_account" >/dev/null 2>&1 ||
    fail "Could not delete the Keychain item. Remove $keychain_account ($app_id) in Keychain Access."
fi

echo "Reset the dev app. Run make dev to start setup."
