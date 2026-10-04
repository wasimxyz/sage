#!/bin/sh
# Refuse a packaged node_modules tree that still holds an agent dev module.
#
# `make package` installs the agent with `npm --prefix agent install --omit=dev`,
# so `typescript`, `@types`, `@biomejs`, `ultracite`, and `@vercel/blob` should
# not be there. npm can still leave the directory behind: it removes
# `@types/node` and keeps an empty `node_modules/@types`. An empty directory
# ships nothing, so only a real package counts. `@types` and `@biomejs` are
# scopes, so `@types/node/package.json` counts while the bare directory does
# not.
#
# Usage: refuse-packaged-dev-modules.sh <node_modules-dir> [...]
# A missing directory is skipped.
set -eu

if [ "$#" -eq 0 ]; then
  echo "refuse-packaged-dev-modules: pass at least one node_modules directory" >&2
  exit 2
fi

status=0

for tree in "$@"; do
  [ -d "$tree" ] || continue
  for dev_module in typescript @types @biomejs ultracite @vercel/blob; do
    module_path="$tree/$dev_module"
    [ -d "$module_path" ] || continue
    # One level under the module name covers `typescript/package.json` and
    # `@types/node/package.json`. Stop at the first hit.
    if [ -n "$(find "$module_path" -maxdepth 2 -name package.json -print -quit 2>/dev/null)" ]; then
      echo "refuse-packaged-dev-modules: $tree contains the dev module $dev_module. Run npm --prefix agent install --omit=dev." >&2
      status=1
    fi
  done
done

exit "$status"
