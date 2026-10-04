#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
script="$root/scripts/release-version.sh"

fail() {
  echo "$1" >&2
  exit 1
}

fixture=$(mktemp -d "${TMPDIR:-/tmp}/sage-release-version-test.XXXXXX")
cleanup() {
  rm -rf "$fixture"
}
trap cleanup EXIT

# Copy only the files the script reads, so the test never touches the repo.
for file in \
  app.json build.zig.zon \
  frontend/package.json frontend/package-lock.json \
  agent/package.json agent/package-lock.json \
  agent/packages/world-encrypted-local/package.json \
  eval-viewer/package.json eval-viewer/package-lock.json
do
  mkdir -p "$fixture/$(dirname "$file")"
  cp "$root/$file" "$fixture/$file"
done
export RELEASE_VERSION_ROOT="$fixture"

version=$(node -p 'require(process.argv[1]).version' "$fixture/app.json")

out=$(sh "$script" "v$version" 2>/dev/null)
[ "$out" = "version=$version
prerelease=false" ] || fail "expected v$version to print a full release, got: $out"

out=$(sh "$script" "v$version-rc.2" 2>/dev/null)
[ "$out" = "version=$version
prerelease=true" ] || fail "expected v$version-rc.2 to print a prerelease, got: $out"

sh "$script" >/dev/null 2>&1 || fail "expected the versions-only check to pass"

for bad in "v0.1" "v$version-beta" "$version" "v$version-rc" "v$version-rc.1.2" "vv$version"; do
  if sh "$script" "$bad" >/dev/null 2>&1; then
    fail "expected tag $bad to be rejected"
  fi
done

if sh "$script" "v99.0.0" >/dev/null 2>&1; then
  fail "expected a tag that does not match app.json to be rejected"
fi

# A stale version anywhere must fail, and the message must name the file.
sed 's/\.version = "[^"]*"/.version = "9.9.9"/' "$fixture/build.zig.zon" >"$fixture/build.zig.zon.new"
mv "$fixture/build.zig.zon.new" "$fixture/build.zig.zon"
if msg=$(sh "$script" 2>&1); then
  fail "expected a stale build.zig.zon to fail"
fi
case "$msg" in
  *"build.zig.zon is 9.9.9"*) ;;
  *) fail "expected the failure to name build.zig.zon, got: $msg" ;;
esac
cp "$root/build.zig.zon" "$fixture/build.zig.zon"

node -e '
const fs = require("fs");
const file = process.argv[1];
const json = JSON.parse(fs.readFileSync(file, "utf8"));
json.packages["packages/world-encrypted-local"].version = "9.9.9";
fs.writeFileSync(file, JSON.stringify(json, null, 2));
' "$fixture/agent/package-lock.json"
if msg=$(sh "$script" 2>&1); then
  fail "expected a stale agent lockfile entry to fail"
fi
case "$msg" in
  *"agent/package-lock.json"*) ;;
  *) fail "expected the failure to name the agent lockfile, got: $msg" ;;
esac
cp "$root/agent/package-lock.json" "$fixture/agent/package-lock.json"

# The updater rejects anything but X.Y.Z, so app.json must too.
sed 's/"version": "[^"]*"/"version": "1.0.0-rc.1"/' "$fixture/app.json" >"$fixture/app.json.new"
mv "$fixture/app.json.new" "$fixture/app.json"
if sh "$script" >/dev/null 2>&1; then
  fail "expected a suffixed app.json version to be rejected"
fi

echo "release-version: ok"
