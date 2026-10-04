#!/bin/sh
# `make eval` must hand `eve eval` a URL target and Sage's agent-server token.
# eve applies EVE_EVAL_AUTH_TOKEN only to a URL target; for a local target it
# starts its own server and sends no token, and the channel answers 401. The
# runner therefore starts one headless server per trio, on loopback and on a
# free port, and reads the token from the throwaway agent-server.json.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
runner="$root/scripts/eval-run.sh"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$runner" ] || fail "missing scripts/eval-run.sh"

# ARGS must not replace the local URL while the runner exports Sage's token.
reject_target_override() {
  if output=$(sh "$runner" "$@" 2>&1); then
    fail "scripts/eval-run.sh accepted caller-supplied --url."
  else
    status=$?
  fi
  [ "$status" -eq 2 ] ||
    fail "scripts/eval-run.sh returned $status instead of rejecting --url."
  printf '%s\n' "$output" | grep -Fq 'make eval controls the target URL' ||
    fail "scripts/eval-run.sh did not explain that it owns --url."
}

reject_target_override --url https://example.invalid
reject_target_override --url=https://example.invalid

# The eval client is a remote client only when the command carries a URL.
grep -F 'eve eval' "$runner" | grep -Fq -- '--url "$eval_url"' ||
  fail "scripts/eval-run.sh runs eve eval without --url."

# One headless server per trio: no UI, loopback only, and a free port so it
# cannot collide with the make dev server on 2000.
server_line=$(grep -F 'eve dev --no-ui' "$runner" || true)
[ -n "$server_line" ] ||
  fail "scripts/eval-run.sh does not start an eval agent server with --no-ui."
printf '%s\n' "$server_line" | grep -Fq -- '--no-default-extensions' ||
  fail "scripts/eval-run.sh does not match the eval server eve starts for a local target."
printf '%s\n' "$server_line" | grep -Fq -- '--host 127.0.0.1' ||
  fail "scripts/eval-run.sh does not bind the eval agent server to 127.0.0.1."
printf '%s\n' "$server_line" | grep -Fq -- '--port 0' ||
  fail "scripts/eval-run.sh does not start the eval agent server on a free port."

# The server checks the throwaway agent-server.json, so the token it expects is
# the one Sage wrote for this trio.
grep -Fq 'SAGE_DISCOVERY_FILE="$SAGE_DISCOVERY_FILE"' "$runner" ||
  fail "scripts/eval-run.sh does not give the eval agent server SAGE_DISCOVERY_FILE."

# The token comes from that file, in the runner shell, and never from agent/.env.
grep -F 'eval_token=' "$runner" | grep -Fq 'SAGE_DISCOVERY_FILE' ||
  fail "scripts/eval-run.sh does not read the eval token from SAGE_DISCOVERY_FILE."
if grep -Fq 'eval_token=$(printf' "$runner" || grep -F 'eval_token=' "$runner" | grep -Fq '.env'; then
  fail "scripts/eval-run.sh takes the eval token from somewhere other than the throwaway file."
fi
if grep -F 'eval_token' "$runner" | grep -Fq 'echo'; then
  fail "scripts/eval-run.sh prints the eval token."
fi

# The token reaches the client process only, not the server.
grep -Fq 'EVE_EVAL_AUTH_TOKEN="$eval_token"' "$runner" ||
  fail "scripts/eval-run.sh does not send the eval token to the client."
if grep -F 'EVE_EVAL_AUTH_TOKEN' "$runner" | grep -Fq 'in_agent eve dev'; then
  fail "scripts/eval-run.sh gives the eval agent server the token it is meant to check."
fi

# Health is public. Waiting on it with a token would pass against a server that
# rejects every token.
health_lines=$(grep -F 'eve/v1/health' "$runner" || true)
[ -n "$health_lines" ] ||
  fail "scripts/eval-run.sh does not wait on /eve/v1/health."
if printf '%s\n' "$health_lines" | grep -Fq 'Authorization'; then
  fail "scripts/eval-run.sh sends an Authorization header while probing health."
fi

# The server holds a port, so every trio must stop the one it started.
grep -Fq 'kill -TERM "$eval_pid"' "$runner" ||
  fail "scripts/eval-run.sh does not stop the eval agent server with SIGTERM."
grep -Fq 'wait "$eval_pid"' "$runner" ||
  fail "scripts/eval-run.sh does not wait for the eval agent server to exit."

echo "eval-server-token tests passed"
