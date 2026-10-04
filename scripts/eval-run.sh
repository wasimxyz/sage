#!/bin/sh
set -eu

for arg do
  case "$arg" in
    --url|--url=*)
      echo "make eval controls the target URL; do not pass --url in ARGS." >&2
      exit 2
      ;;
  esac
done

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
agent="$root/agent"
reports="$agent/evals/reports"
timestamp=$(date -u +"%Y%m%dT%H%M%SZ")

# shellcheck disable=SC1091
. "$root/scripts/eval-env.sh"
load_eval_env "$agent"

summary_models=${SAGE_SUMMARY_MODELS:-${SAGE_SUMMARY_MODEL:-qwen3.5:9b}}
embed_models=${SAGE_EMBED_MODELS:-${SAGE_EMBED_MODEL:-nomic-embed-text}}
chat_models=${SAGE_CHAT_MODELS:-${SAGE_CHAT_MODEL:-${OLLAMA_MODEL:-qwen3.5:9b}}}
judge_model=${SAGE_JUDGE_MODEL:-qwen3.5:9b}

mkdir -p "$reports"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing $1." >&2
    exit 1
  fi
}

need_cmd curl
need_cmd ollama
need_cmd native
need_cmd node

if ! curl -sf --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Ollama is not running at http://127.0.0.1:11434." >&2
  exit 1
fi

pull_models() {
  old_ifs=$IFS
  IFS=,
  for model in $1; do
    model=$(printf '%s' "$model" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -n "$model" ]; then
      echo "Pulling $model"
      ollama pull "$model"
    fi
  done
  IFS=$old_ifs
}

pull_models "$summary_models"
pull_models "$embed_models"
pull_models "$chat_models"
pull_models "$judge_model"

cd "$root"
eval_prefix="$root/zig-out/eval"

rm_eval_prefix() {
  rm -rf "$eval_prefix"
}
trap rm_eval_prefix EXIT
trap 'rm_eval_prefix; exit 1' INT TERM

# `native build` forwards -D flags only and passes no prefix of its own for an
# ejected app, so the throwaway install arrives as an option, not --prefix.
native build -Dinstall-prefix="$eval_prefix" -Dautomation=true -Dmemory=true

binary="$eval_prefix/bin/Sage"
if [ ! -x "$binary" ]; then
  echo "Sage binary was not built at $binary." >&2
  exit 1
fi

if [ ! -d "$agent/node_modules" ]; then
  npm --prefix "$agent" install
fi

run_one() {
  summary_model=$1
  embed_model=$2
  chat_model=$3
  shift 3
  run_id=$(printf '%s' "${summary_model}__${embed_model}__${chat_model}__${timestamp}" | tr '/:' '__')
  data_dir=$(mktemp -d "${TMPDIR:-/tmp}/sage-eval.XXXXXX")
  sage_pid=""
  eval_pid=""

  cleanup() {
    if [ -n "$eval_pid" ]; then
      # eve's dev command closes the detached server child it forked, then
      # exits, so the port is free before the next trio starts its own.
      kill -TERM "$eval_pid" 2>/dev/null || true
      wait "$eval_pid" 2>/dev/null || true
    fi
    if [ -n "$sage_pid" ]; then
      kill "$sage_pid" 2>/dev/null || true
      wait "$sage_pid" 2>/dev/null || true
    fi
    if [ -f "$data_dir/sage.log" ]; then
      cp "$data_dir/sage.log" "$reports/${run_id}.sage.log" || true
    fi
    if [ -f "$data_dir/manifest.json" ]; then
      cp "$data_dir/manifest.json" "$reports/${run_id}.manifest.json" || true
    fi
    rm -rf "$data_dir"
  }
  trap cleanup EXIT

  mkdir -p "$data_dir/frontend/dist"
  printf '%s\n' '<!doctype html><html><head><meta charset="utf-8"><title>Sage eval</title></head><body></body></html>' >"$data_dir/frontend/dist/index.html"
  ln -s "$root/app.json" "$data_dir/app.json"

  export SAGE_REPO_ROOT="$root"
  export SAGE_EVAL_DATA="$root/agent/evals/data"
  export SAGE_AUTOMATION_CWD="$data_dir"
  export SAGE_DATA_DIR="$data_dir"
  export SAGE_DISCOVERY_FILE="$data_dir/agent-server.json"
  export SAGE_EVAL_MANIFEST="$data_dir/manifest.json"
  export SAGE_SUMMARY_MODEL="$summary_model"
  export SAGE_EMBED_MODEL="$embed_model"
  export SAGE_CHAT_MODEL="$chat_model"
  export SAGE_CHAT_MODELS="$chat_model"
  export SAGE_JUDGE_MODEL="$judge_model"
  export SAGE_EVAL_CACHE_DIR="${SAGE_EVAL_CACHE_DIR:-$agent/evals/.cache/dream}"
  export SAGE_EVAL_TRANSCRIPTS="$data_dir/chat-transcripts.jsonl"
  export SAGE_EVAL_EMBEDDINGS="$data_dir/query-embeddings.jsonl"
  export SAGE_EVAL_RESULTS="$data_dir/eval-results.jsonl"
  : >"$SAGE_EVAL_TRANSCRIPTS"
  : >"$SAGE_EVAL_EMBEDDINGS"
  : >"$SAGE_EVAL_RESULTS"

  cache_enabled=1
  if [ "${SAGE_EVAL_CACHE:-1}" = "0" ]; then
    cache_enabled=0
  fi
  cache_dir="$SAGE_EVAL_CACHE_DIR"
  cache_hit=0
  cache_key=""

  if [ "$cache_enabled" -eq 1 ]; then
    cache_key=$(node --experimental-strip-types "$agent/scripts/eval-cache.ts" key)
    if [ -f "$cache_dir/$cache_key/app.db" ] && [ -f "$cache_dir/$cache_key/manifest.json" ]; then
      echo "Using cached Dream artifacts ($cache_key)"
      cp "$cache_dir/$cache_key/app.db" "$data_dir/app.db"
      cp "$cache_dir/$cache_key/manifest.json" "$data_dir/manifest.json"
      cache_hit=1
    else
      echo "No cached Dream artifacts for this dataset and model pair."
    fi
  fi

  echo "Starting Sage in $data_dir"
  (
    cd "$data_dir"
    SAGE_DATA_DIR="$data_dir" \
      SAGE_SUMMARY_MODEL="$summary_model" \
      SAGE_EMBED_MODEL="$embed_model" \
      exec "$binary" >"$data_dir/sage.log" 2>&1
  ) &
  sage_pid=$!

  i=0
  while [ "$i" -lt 300 ]; do
    if [ -f "$data_dir/agent-server.json" ] && [ -d "$data_dir/.zig-cache/native-sdk-automation" ]; then
      break
    fi
    if ! kill -0 "$sage_pid" 2>/dev/null; then
      echo "Sage exited before it was ready. Log:" >&2
      cat "$data_dir/sage.log" >&2 || true
      exit 1
    fi
    i=$((i + 1))
    sleep 0.1
  done
  if [ ! -f "$data_dir/agent-server.json" ]; then
    echo "Sage did not write agent-server.json. Log:" >&2
    cat "$data_dir/sage.log" >&2 || true
    exit 1
  fi
  if [ ! -d "$data_dir/.zig-cache/native-sdk-automation" ]; then
    echo "Sage did not create its automation folder. Log:" >&2
    cat "$data_dir/sage.log" >&2 || true
    exit 1
  fi

  if ! ( cd "$data_dir" && native automate wait >/dev/null ); then
    echo "Sage automation did not become ready. Log:" >&2
    cat "$data_dir/sage.log" >&2 || true
    exit 1
  fi

  if [ "$cache_hit" -eq 0 ]; then
    node --experimental-strip-types "$agent/scripts/seed-dataset.ts"
    if [ "$cache_enabled" -eq 1 ]; then
      node --experimental-strip-types "$agent/scripts/eval-cache.ts" snapshot "$cache_key"
    fi
  fi

  in_agent() {
    (
      cd "$agent"
      EVE_TELEMETRY_DISABLED=1 \
        SAGE_DISCOVERY_FILE="$SAGE_DISCOVERY_FILE" \
        SAGE_DATA_DIR="$SAGE_DATA_DIR" \
        SAGE_EVAL_DATA="$SAGE_EVAL_DATA" \
        SAGE_REPO_ROOT="$SAGE_REPO_ROOT" \
        SAGE_EVAL_MANIFEST="$SAGE_EVAL_MANIFEST" \
        SAGE_EVAL_TRANSCRIPTS="$SAGE_EVAL_TRANSCRIPTS" \
        SAGE_EVAL_EMBEDDINGS="$SAGE_EVAL_EMBEDDINGS" \
        SAGE_EVAL_RESULTS="$SAGE_EVAL_RESULTS" \
        SAGE_CHAT_MODEL="$SAGE_CHAT_MODEL" \
        SAGE_CHAT_MODELS="$SAGE_CHAT_MODELS" \
        SAGE_EMBED_MODEL="$SAGE_EMBED_MODEL" \
        SAGE_JUDGE_MODEL="$SAGE_JUDGE_MODEL" \
        NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=\"$agent/agent/lib/workflow-guard-preload.ts\"" \
        PATH="$agent/node_modules/.bin:$PATH" \
        exec "$@"
    )
  }

  # The token stays in this shell. It is never echoed, and it never comes from
  # agent/.env.
  eval_token=$(node -e 'const fs = require("node:fs"); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).token))' "$SAGE_DISCOVERY_FILE") || {
    echo "Could not read the agent-server token from $SAGE_DISCOVERY_FILE." >&2
    exit 1
  }
  if [ -z "$eval_token" ]; then
    echo "Sage wrote no agent-server token in $SAGE_DISCOVERY_FILE." >&2
    exit 1
  fi

  # The passes below get a URL target, because that is the only target eve
  # applies EVE_EVAL_AUTH_TOKEN to. `eve eval` starts its own server for a local
  # target, and that server would answer 401 without the token. One headless
  # server covers chat, embeddings, and the judge pass. `--host 127.0.0.1` keeps
  # it off other interfaces, and port 0 keeps it off the `make dev` server.
  eval_log="$data_dir/eve-dev.log"
  echo "Starting the eval agent server"
  in_agent eve dev --no-ui --no-default-extensions --host 127.0.0.1 --port 0 >"$eval_log" 2>&1 &
  eval_pid=$!

  eval_port=""
  eval_url=""
  i=0
  while [ "$i" -lt 240 ]; do
    eval_port=$(sed -n 's|.*server listening at http://127\.0\.0\.1:\([0-9]*\).*|\1|p' "$eval_log" | head -n 1)
    if [ -n "$eval_port" ]; then
      eval_url="http://127.0.0.1:$eval_port"
      break
    fi
    if ! kill -0 "$eval_pid" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 0.5
  done

  i=0
  while [ -n "$eval_url" ] && [ "$i" -lt 240 ]; do
    if curl -sf -o /dev/null --max-time 2 "$eval_url/eve/v1/health"; then
      break
    fi
    if ! kill -0 "$eval_pid" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 0.5
  done
  # Health is public, so this probe sends no Authorization header.
  if [ -z "$eval_url" ] || ! curl -sf -o /dev/null --max-time 2 "$eval_url/eve/v1/health"; then
    echo "The eval agent server did not answer /eve/v1/health. Log:" >&2
    cat "$eval_log" >&2 || true
    exit 1
  fi

  run_eve() {
    (
      export EVE_EVAL_AUTH_TOKEN="$eval_token"
      in_agent eve eval --max-concurrency 1 --url "$eval_url" "$@"
    )
  }

  junit="$reports/${run_id}.xml"
  gen_xml="$data_dir/gen.xml"
  embed_xml="$data_dir/embed.xml"
  judge_xml="$data_dir/judge.xml"

  list_status=0
  list_out=$(run_eve chat --list "$@" 2>"$data_dir/chat-list.err") || list_status=$?
  if [ "$list_status" -ne 0 ] && [ "$list_status" -ne 2 ]; then
    echo "Could not list chat evals (exit $list_status)." >&2
    cat "$data_dir/chat-list.err" >&2 || true
    exit "$list_status"
  fi

  gen_status=0
  if [ -n "$(printf '%s' "$list_out" | tr -d '[:space:]')" ]; then
    echo "Generating chat turns"
    run_eve chat --junit "$gen_xml" "$@" || gen_status=$?
  else
    echo "Skipping chat generation (no matching chat evals)."
  fi

  embed_list_status=0
  embed_list_out=$(run_eve embeddings --list "$@" 2>"$data_dir/embed-list.err") || embed_list_status=$?
  if [ "$embed_list_status" -ne 0 ] && [ "$embed_list_status" -ne 2 ]; then
    echo "Could not list embedding evals (exit $embed_list_status)." >&2
    cat "$data_dir/embed-list.err" >&2 || true
    exit "$embed_list_status"
  fi

  embed_status=0
  if [ -n "$(printf '%s' "$embed_list_out" | tr -d '[:space:]')" ]; then
    echo "Generating query embeddings"
    run_eve embeddings --junit "$embed_xml" "$@" || embed_status=$?
  else
    echo "Skipping query embeddings (no matching embeddings evals)."
  fi

  judge_status=0
  echo "Judging saved replies"
  run_eve chat-judge extraction summaries retrieval --junit "$judge_xml" "$@" || judge_status=$?

  node --experimental-strip-types "$agent/scripts/merge-junit.ts" "$junit" "$gen_xml" "$embed_xml" "$judge_xml" "$SAGE_EVAL_RESULTS"

  if [ "$gen_status" -ne 0 ] || [ "$embed_status" -ne 0 ] || [ "$judge_status" -ne 0 ]; then
    exit 1
  fi

  trap - EXIT
  cleanup
}

sweep_failed=0
sweep_failed_runs=""

old_ifs=$IFS
IFS=,
for summary_model in $summary_models; do
  for embed_model in $embed_models; do
    for chat_model in $chat_models; do
      IFS=$old_ifs
      summary_model=$(printf '%s' "$summary_model" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      embed_model=$(printf '%s' "$embed_model" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      chat_model=$(printf '%s' "$chat_model" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      run_status=0
      # Isolate each trio so a failed eval cannot skip the rest of the sweep.
      (
        set -e
        run_one "$summary_model" "$embed_model" "$chat_model" "$@"
      ) || run_status=$?
      if [ "$run_status" -ne 0 ]; then
        echo "Eval run failed: summary=$summary_model embed=$embed_model chat=$chat_model (exit $run_status)" >&2
        sweep_failed=1
        sweep_failed_runs="$sweep_failed_runs ${summary_model}+${embed_model}+${chat_model}"
      fi
      IFS=,
    done
  done
done
IFS=$old_ifs

rm_eval_prefix

sh "$root/scripts/eval-upload.sh"

if [ "$sweep_failed" -ne 0 ]; then
  echo "Some eval runs failed:$sweep_failed_runs" >&2
  exit 1
fi
