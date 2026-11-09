#!/bin/sh
# Download the models the dictation voice test needs, pinned by SHA-256, into
# third_party/dictation-spike/ (gitignored):
#   - NVIDIA Parakeet TDT 0.6B v2, int8, as packaged by sherpa-onnx (about 480 MB)
#   - the Silero voice activity detector (about 640 KB)
# Apple's speech model is not here: macOS installs it, and the Apple runner
# asks for it on first use.
set -eu

# SHA-256 values from the GitHub release's asset digests,
# https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
release="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
parakeet_name="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
parakeet_sha="6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714"
vad_sha="9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"

root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
dest="$root/third_party/dictation-spike"
mkdir -p "$dest"

log() {
  echo "fetch-models: $*" >&2
}

verify() {
  # $1 = file, $2 = expected SHA-256
  (cd "$(dirname "$1")" && printf '%s  %s\n' "$2" "$(basename "$1")" | shasum -a 256 -c - >&2)
}

fetch_pinned() {
  # $1 = URL, $2 = destination, $3 = expected SHA-256
  if [ -f "$2" ] && verify "$2" "$3"; then
    return 0
  fi
  part="$2.$$.partial"
  log "downloading $1"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$part" "$1"; then
    rm -f "$part"
    log "download failed: $1"
    exit 1
  fi
  if ! verify "$part" "$3"; then
    rm -f "$part"
    log "checksum mismatch: $1"
    exit 1
  fi
  mv "$part" "$2"
}

fetch_pinned "$release/silero_vad.onnx" "$dest/silero_vad.onnx" "$vad_sha"

if [ -f "$dest/$parakeet_name/encoder.int8.onnx" ] && [ -f "$dest/$parakeet_name/.sha256" ] \
  && [ "$(cat "$dest/$parakeet_name/.sha256")" = "$parakeet_sha" ]; then
  log "Parakeet is already in place"
else
  archive="$dest/$parakeet_name.tar.bz2"
  fetch_pinned "$release/$parakeet_name.tar.bz2" "$archive" "$parakeet_sha"
  rm -rf "$dest/$parakeet_name"
  tar -xjf "$archive" -C "$dest"
  printf '%s' "$parakeet_sha" > "$dest/$parakeet_name/.sha256"
  rm -f "$archive"
fi

log "models are in $dest"
