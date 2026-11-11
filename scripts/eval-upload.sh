#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
agent="$root/agent"
reports="$agent/evals/reports"

list_reports() {
  if [ ! -d "$reports" ]; then
    return 0
  fi
  find "$reports" -maxdepth 1 -type f ! -name '.*' | sort
}

confirm_upload() {
  if [ ! -t 0 ]; then
    echo "Skipping Vercel Blob upload (stdin is not a terminal). Run make eval-upload from a terminal to upload later."
    return 1
  fi
  printf 'Upload eval reports to Vercel Blob? [y/N] '
  answer=
  IFS= read -r answer || true
  case $answer in
    y|Y|yes|YES) return 0 ;;
    *)
      echo "Skipping upload."
      return 1
      ;;
  esac
}

files=$(list_reports)
if [ -z "$files" ]; then
  echo "No eval reports to upload."
  exit 0
fi

echo "Eval reports in $reports:"
printf '%s\n' "$files" | sed "s|^$reports/|  |"

if ! confirm_upload; then
  exit 0
fi

if [ ! -d "$agent/node_modules/@vercel/blob" ]; then
  npm --prefix "$agent" install
fi

# The script loads agent/.env, then agent/.env.local, for the Blob token.
node --experimental-strip-types "$agent/scripts/upload-eval-reports.ts"
