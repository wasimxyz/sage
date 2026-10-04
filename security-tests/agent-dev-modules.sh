#!/bin/sh
# make package must ship a production agent tree, without the dev modules.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
makefile="$root/Makefile"
copy_script="$root/scripts/copy-agent-into-app.sh"
guard_script="$root/scripts/refuse-packaged-dev-modules.sh"

fail() {
  echo "$1" >&2
  exit 1
}

[ -f "$makefile" ] || fail "missing Makefile"
[ -f "$copy_script" ] || fail "missing scripts/copy-agent-into-app.sh"
[ -f "$guard_script" ] || fail "missing scripts/refuse-packaged-dev-modules.sh"

# The package target installs the agent without devDependencies. `make setup`
# and `make dev` keep the full install, for typecheck and for `eve dev`.
package_target=$(sed -n '/^package:/,/^$/p' "$makefile")
install_lines=$(printf '%s\n' "$package_target" | grep -F 'npm --prefix agent install' || true)
[ -n "$install_lines" ] || fail "Makefile does not install the agent for the package target."

if printf '%s\n' "$install_lines" | grep -Fvq -- '--omit=dev'; then
  fail "Makefile installs the agent with devDependencies for package."
fi

# Deleting dev modules after the copy hid a dev install. The copy must refuse a
# tree that still holds them.
if grep -Fq 'rm -rf "$dest/node_modules/typescript"' "$copy_script"; then
  fail "copy-agent-into-app.sh deletes typescript after the copy instead of installing production modules."
fi

# A dev module in the tree must stop the copy. The copy hands both copied
# node_modules trees to the guard, so a dev module under `.output/` cannot slip
# through on the strength of a clean top-level tree.
guard_call=$(grep -F 'refuse-packaged-dev-modules.sh' "$copy_script" || true)
[ -n "$guard_call" ] ||
  fail "copy-agent-into-app.sh does not refuse a packaged dev module."

for tree in '$dest/node_modules' '$dest/.output/server/node_modules'; do
  case "$guard_call" in
    *"$tree"*) ;;
    *) fail "copy-agent-into-app.sh does not check $tree for dev modules." ;;
  esac
done

# The guard itself: exit 1 only for a real package under a dev module name.
# Fixture trees, so nothing here touches agent/node_modules or downloads Node.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

module_trees="node_modules .output/server/node_modules"

# npm removes `@types/node` and leaves the `@types` directory behind. The
# directory ships nothing.
for tree in $module_trees; do
  fixture="$tmp/empty/$tree"
  mkdir -p "$fixture/@types" "$fixture/@biomejs" "$fixture/@vercel"
  sh "$guard_script" "$fixture" ||
    fail "an empty $tree/@types directory counts as a shipped dev module."
done

# A tree the copy never wrote is skipped.
sh "$guard_script" "$tmp/empty/absent" ||
  fail "the guard fails on a missing node_modules directory."

for tree in $module_trees; do
  for dev_module in typescript @types/node @biomejs/biome ultracite @vercel/blob; do
    fixture="$tmp/real/$tree"
    rm -rf "$tmp/real"
    mkdir -p "$fixture/$dev_module"
    echo '{}' >"$fixture/$dev_module/package.json"
    if sh "$guard_script" "$fixture" 2>/dev/null; then
      fail "the guard accepts $dev_module in $tree."
    fi
  done
done

# The packaged sandbox is eve's default engine, so it stays in the bundle.
fixture="$tmp/sandbox/node_modules"
mkdir -p "$fixture/microsandbox"
echo '{}' >"$fixture/microsandbox/package.json"
sh "$guard_script" "$fixture" ||
  fail "the guard rejects microsandbox, the packaged sandbox engine."

# Copy only `agent/`, `.output/`, `package.json`, and production node_modules.
sources=$(sed -n 's/^rsync -a --delete "\([^"]*\)".*$/\1/p' "$copy_script")
[ -n "$sources" ] || fail "copy-agent-into-app.sh copies no agent files."

allowed=" \$src/agent/ \$src/.output/ \$src/node_modules/ \$world_src/ "
for source in $sources; do
  case "$allowed" in
    *" $source "*) ;;
    *) fail "copy-agent-into-app.sh copies $source into the bundle." ;;
  esac
done

echo "agent-dev-modules tests passed"
