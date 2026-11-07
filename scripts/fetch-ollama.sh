#!/bin/sh
# Download a pinned Ollama CLI so Sage can run its own local AI server without
# a system Ollama.
#
# No argument: fill the cache and print the absolute path of the ollama binary
# on stdout. Dev and evals use this. Progress and errors go to stderr, so stdout
# holds only the path.
#
# With a Sage.app path: copy the whole extracted tree into
# Contents/Resources/ollama, keeping the archive's layout, so the binary finds
# its libraries beside it. The tree keeps only arm64 code: Intel-only Mach-O
# files are deleted, and so are the symlinks left pointing at them.
set -eu

OLLAMA_VERSION="0.40.15"

# SHA256 of ollama-darwin.tgz from
# https://github.com/ollama/ollama/releases/download/v0.40.15/sha256sum.txt
expected_sha="607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8"

# The archive has no LICENSE file. When it is missing, the MIT license comes
# from the same tag. SHA256 of
# https://raw.githubusercontent.com/ollama/ollama/v0.40.15/LICENSE
license_sha="5934ed2ce0d15154bcdb9c85203210abac0da4314af34081e36df4599f90b226"

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
app="${1:-}"

tarball="ollama-darwin.tgz"
url="https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${tarball}"
license_url="https://raw.githubusercontent.com/ollama/ollama/v${OLLAMA_VERSION}/LICENSE"
cache="$root/third_party/ollama/v${OLLAMA_VERSION}"
dist="$cache/dist"
stamp="$cache/extracted.sha256"

if [ -n "$app" ] && [ ! -d "$app" ]; then
  echo "fetch-ollama: no Sage .app bundle found at $app" >&2
  exit 1
fi

log() {
  echo "fetch-ollama: $*" >&2
}

# Check the SHA-256 of a file. shasum prints "OK" on stdout, so send it to
# stderr to keep stdout for the path.
verify() {
  name=$(basename "$1")
  dir=$(dirname "$1")
  line="$2  $name"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$dir" && printf '%s\n' "$line" | shasum -a 256 -c - >&2)
  else
    (cd "$dir" && printf '%s\n' "$line" | sha256sum -c - >&2)
  fi
}

download() {
  # $1 = URL, $2 = destination
  part="$2.$$.partial"
  log "downloading $1"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$part" "$1"; then
    rm -f "$part"
    log "download failed: $1"
    exit 1
  fi
  mv "$part" "$2"
}

# Keep a cached file only while it matches its pinned SHA-256. Download it
# again when it is missing or does not match.
fetch_pinned() {
  # $1 = URL, $2 = cached file, $3 = expected SHA-256
  if [ -f "$2" ] && verify "$2" "$3"; then
    return 0
  fi
  rm -f "$2"
  download "$1" "$2"
  if ! verify "$2" "$3"; then
    rm -f "$2"
    log "checksum failed for $(basename "$2")"
    exit 1
  fi
}

# Keep only arm64 code. Sage ships for Apple silicon, and an arm64 process cannot
# load an x86_64-only file, so a Mach-O file with no arm64 slice is deleted.
# A universal file is thinned to its arm64 slice. Other files stay as they are,
# including both mlx_metal_v3 and mlx_metal_v4.
keep_arm64_only() {
  # $1 = extracted tree
  find "$1" -type f | while IFS= read -r file; do
    rel=${file#"$1"/}
    archs=$(lipo -archs "$file" 2>/dev/null) || continue
    case " $archs " in
      *" arm64 "*) ;;
      *)
        rm -f "$file"
        log "removed $rel (no arm64 slice: $archs)"
        continue
        ;;
    esac
    if [ "$archs" != "arm64" ]; then
      lipo -thin arm64 "$file" -output "$file.arm64"
      mv "$file.arm64" "$file"
      log "thinned $rel from $archs to arm64"
    fi
  done
}

# Delete each symlink whose target is gone, so no dangling link is left. The
# test `-e` follows the whole chain, so one pass also catches links to links.
remove_dangling_links() {
  # $1 = extracted tree
  find "$1" -type l | while IFS= read -r link; do
    if [ ! -e "$link" ]; then
      rel=${link#"$1"/}
      rm -f "$link"
      log "removed dangling symlink $rel"
    fi
  done
}

# Unpack the archive into a staging folder, check its layout, thin it, and move
# it into place. The move is the last step, so a failed build never leaves a
# half-built tree behind.
build_dist() {
  rm -rf "$dist"
  stage=$(mktemp -d "$cache/dist.XXXXXX")
  trap 'rm -rf "$stage"' EXIT INT TERM
  tar -xzf "$cache/$tarball" -C "$stage"

  if [ ! -x "$stage/ollama" ]; then
    log "the archive has no executable ollama at its root"
    exit 1
  fi
  if [ ! -f "$stage/LICENSE" ]; then
    fetch_pinned "$license_url" "$cache/LICENSE" "$license_sha"
    cp "$cache/LICENSE" "$stage/LICENSE"
  fi

  keep_arm64_only "$stage"
  remove_dangling_links "$stage"
  chmod +x "$stage/ollama"
  chmod 755 "$stage"
  mv "$stage" "$dist"
  trap - EXIT INT TERM
  printf '%s\n' "$expected_stamp" >"$stamp"
}

mkdir -p "$cache"
fetch_pinned "$url" "$cache/$tarball" "$expected_sha"

# Re-extract when the cached tree is missing, came from another archive, or was
# built under an older rule. Bump build_rev when the tree rules change.
build_rev="arm64-only-2"
expected_stamp="$expected_sha $build_rev"
if [ ! -x "$dist/ollama" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$expected_stamp" ]; then
  build_dist
fi

if [ -z "$app" ]; then
  printf '%s\n' "$dist/ollama"
  exit 0
fi

dest="$app/Contents/Resources/ollama"
rm -rf "$dest"
mkdir -p "$app/Contents/Resources"
cp -Rp "$dist" "$dest"
chmod +x "$dest/ollama"
log "copied Ollama $OLLAMA_VERSION into $dest"
