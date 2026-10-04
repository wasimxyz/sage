# Sourced by eval-run.sh and eval-upload.sh.
# Loads agent/.env, then agent/.env.local. Values already exported in the
# shell keep their values.

load_eval_env() {
  agent_dir=${1:-}
  if [ -z "$agent_dir" ]; then
    echo "load_eval_env requires the agent directory." >&2
    return 1
  fi

  snapshot=$(mktemp "${TMPDIR:-/tmp}/sage-eval-env.XXXXXX") || return 1
  export -p >"$snapshot"
  if [ -f "$agent_dir/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$agent_dir/.env"
    set +a
  fi
  if [ -f "$agent_dir/.env.local" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$agent_dir/.env.local"
    set +a
  fi
  # shellcheck disable=SC1090
  . "$snapshot"
  rm -f "$snapshot"
}
