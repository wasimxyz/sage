#!/bin/sh
# Check that every version in the repo matches app.json. With a release tag,
# also check the tag and print `version=` and `prerelease=` lines for
# $GITHUB_OUTPUT. Messages go to stderr so stdout stays clean for that.
#
#   sh scripts/release-version.sh            # versions only (make check)
#   sh scripts/release-version.sh v0.1.0-rc.1
set -eu

root="${RELEASE_VERSION_ROOT:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}"
tag="${1:-}"

fail() {
  echo "release-version: $1" >&2
  exit 1
}

rows=$(node -e '
const fs = require("fs");
const path = require("path");
const root = process.argv[1];
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const rows = [];
const add = (label, value) => rows.push(label + "\t" + value);
const pkg = (file) => add(file, read(file).version);
const lock = (file, ...inner) => {
  const json = read(file);
  add(file, json.version);
  add(file + " packages[\"\"]", json.packages[""].version);
  for (const key of inner) add(file + " packages[\"" + key + "\"]", json.packages[key].version);
};
pkg("app.json");
pkg("frontend/package.json");
lock("frontend/package-lock.json");
pkg("agent/package.json");
lock("agent/package-lock.json", "packages/world-encrypted-local");
pkg("agent/packages/world-encrypted-local/package.json");
pkg("eval-viewer/package.json");
lock("eval-viewer/package-lock.json");
console.log(rows.join("\n"));
' "$root")

zon=$(sed -n 's/^ *\.version = "\([^"]*\)",.*/\1/p' "$root/build.zig.zon")
rows=$(printf '%s\nbuild.zig.zon\t%s\n' "$rows" "$zon")

app_version=$(printf '%s\n' "$rows" | awk -F '\t' '$1 == "app.json" { print $2 }')

# The updater compares plain X.Y.Z versions and rejects anything else.
printf '%s\n' "$app_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  fail "app.json version \"$app_version\" must look like 1.2.3"

mismatches=$(printf '%s\n' "$rows" | awk -F '\t' -v want="$app_version" '$2 != want { printf "  %s is %s\n", $1, $2 }')
if [ -n "$mismatches" ]; then
  echo "release-version: these versions do not match app.json ($app_version):" >&2
  echo "$mismatches" >&2
  exit 1
fi

if [ -z "$tag" ]; then
  echo "release-version: all versions match app.json ($app_version)" >&2
  exit 0
fi

printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' ||
  fail "tag \"$tag\" must look like v1.2.3 or v1.2.3-rc.1"

tag_version="${tag#v}"
tag_version="${tag_version%%-*}"
[ "$tag_version" = "$app_version" ] ||
  fail "tag $tag builds $tag_version, but app.json is $app_version. Bump app.json first."

case "$tag" in
  *-rc.*) prerelease=true ;;
  *) prerelease=false ;;
esac

echo "version=$app_version"
echo "prerelease=$prerelease"
