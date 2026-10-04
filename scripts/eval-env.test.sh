#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/scripts/eval-env.sh"

fail() {
  echo "$1" >&2
  exit 1
}

agent_dir=$(mktemp -d "${TMPDIR:-/tmp}/sage-eval-env-test.XXXXXX")
cleanup() {
  rm -rf "$agent_dir"
}
trap cleanup EXIT

printf '%s\n' \
  'SAGE_CHAT_MODELS=from-env' \
  'SAGE_JUDGE_MODEL=from-env' \
  'SAGE_EMBED_MODELS=from-env' \
  >"$agent_dir/.env"
printf '%s\n' \
  'SAGE_CHAT_MODELS=from-local' \
  'SAGE_SUMMARY_MODELS=from-local' \
  >"$agent_dir/.env.local"

unset SAGE_CHAT_MODELS SAGE_JUDGE_MODEL SAGE_EMBED_MODELS SAGE_SUMMARY_MODELS || true

load_eval_env "$agent_dir"
[ "${SAGE_CHAT_MODELS:-}" = "from-local" ] || fail "expected .env.local to win over .env for SAGE_CHAT_MODELS"
[ "${SAGE_JUDGE_MODEL:-}" = "from-env" ] || fail "expected .env to fill SAGE_JUDGE_MODEL"
[ "${SAGE_SUMMARY_MODELS:-}" = "from-local" ] || fail "expected .env.local to set SAGE_SUMMARY_MODELS"
[ "${SAGE_EMBED_MODELS:-}" = "from-env" ] || fail "expected .env to set SAGE_EMBED_MODELS"

SAGE_CHAT_MODELS=from-shell
export SAGE_CHAT_MODELS
load_eval_env "$agent_dir"
[ "$SAGE_CHAT_MODELS" = "from-shell" ] || fail "expected the shell to win over the env files"

empty_dir=$(mktemp -d "${TMPDIR:-/tmp}/sage-eval-env-empty.XXXXXX")
load_eval_env "$empty_dir"
rm -rf "$empty_dir"

echo "eval-env tests passed"
