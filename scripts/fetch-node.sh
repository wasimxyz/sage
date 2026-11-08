#!/bin/sh
# Download a pinned Node.js into a packaged Sage.app so Chat does not
# need a system Node.
set -eu

NODE_VERSION="24.22.2"

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
app="${1:-}"

if [ -z "$app" ] || [ ! -d "$app" ]; then
  echo "fetch-node: no Sage .app bundle found" >&2
  exit 1
fi

# SHA256 of the official darwin tarballs from
# https://nodejs.org/dist/v24.22.2/SHASUMS256.txt
case "$(uname -m)" in
  arm64|aarch64)
    arch="arm64"
    expected_sha="aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a"
    ;;
  x86_64|amd64)
    arch="x64"
    expected_sha="d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52"
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
