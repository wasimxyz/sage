#!/bin/sh
# Download a pinned Node.js into a packaged Sage.app so Chat does not
# need a system Node.
set -eu

NODE_VERSION="24.21.0"

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
app="${1:-}"

if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "fetch-node: no Sage .app bundle found" >&2
  exit 1
fi

# SHA256 of the official darwin tarballs from
# https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
case "$(uname -m)" in
  arm64|aarch64)
    arch="arm64"
    expected_sha="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
    ;;
  x86_64|amd64)
    arch="x64"
    expected_sha="1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"
    ;;
  *)
    echo "fetch-node: unsupported machine $(uname -m)" >&2
    exit 1
    ;;
esac

base="node-v${NODE_VERSION}-darwin-${arch}"
tarball="${base}.tar.gz"
url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
cache="$root/third_party/node/v${NODE_VERSION}"
dest="$app/Contents/Resources/node"

mkdir -p "$cache"

download() {
  src=$1
  out=$2
  echo "fetch-node: downloading $src"
  curl -fsSL --retry 3 --retry-delay 2 -o "$out.partial" "$src"
  mv "$out.partial" "$out"
}

verify_tarball() {
  file=$1
  expected=$2
  name=$(basename "$file")
  line="${expected}  ${name}"
  dir=$(dirname "$file")
  if command -v shasum >/dev/null 2>&1; then
    (cd "$dir" && printf '%s\n' "$line" | shasum -a 256 -c -)
  else
    (cd "$dir" && printf '%s\n' "$line" | sha256sum -c -)
  fi
}

if [ -f "$cache/$tarball" ] && verify_tarball "$cache/$tarball" "$expected_sha"; then
  :
else
  rm -f "$cache/$tarball"
  download "$url" "$cache/$tarball"
  if ! verify_tarball "$cache/$tarball" "$expected_sha"; then
    rm -f "$cache/$tarball"
    echo "fetch-node: checksum failed for $tarball" >&2
    exit 1
  fi
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/sage-node.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$cache/$tarball" -C "$tmp" "${base}/bin/node" "${base}/LICENSE"

rm -rf "$dest"
mkdir -p "$dest/bin"
cp "$tmp/${base}/bin/node" "$dest/bin/node"
cp "$tmp/${base}/LICENSE" "$dest/LICENSE"
chmod +x "$dest/bin/node"

echo "Copied Node.js ${NODE_VERSION} into $dest"
