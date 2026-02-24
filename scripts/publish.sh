#!/bin/bash
set -e

# Custom publish script that resolves Bun's workspace:* protocol before publishing.
#
# Changesets' built-in publish uses `npm publish` directly on the package
# directory, which does NOT resolve Bun's `workspace:*` protocol — resulting
# in broken packages on npm with literal "workspace:*" strings.
#
# This script uses a two-step approach:
# 1. Resolve workspace:* deps to real versions, then `bun pm pack`
# 2. `npm publish <tarball>` — publishes the tarball (npm handles auth via .npmrc)
#
# We resolve workspace:* ourselves because `bun pm pack` reads versions from the
# lockfile, and Bun's lockfile caches stale workspace versions that `bun install`
# won't refresh (the specifier workspace:* doesn't change when a version bumps).
#
# We use npm for the publish step because `bun publish` has an authentication bug
# in v1.3.x where it fails to read credentials from .npmrc in CI environments:
#   https://github.com/oven-sh/bun/issues/24124
#   https://github.com/oven-sh/bun/issues/18670

PACKAGES=(
  "packages/common"
  "packages/crypto"
  "packages/dids"
  "packages/dwn-sdk-js"
  "packages/dwn-clients"
  "packages/agent"
  "packages/api"
  "packages/protocols"
  "packages/browser"
  "packages/dwn-sql-store"
  "packages/dwn-server"
)

# resolve_workspace_deps <package.json path>
#
# Replaces "workspace:*" dependency values with the actual version from the
# corresponding workspace package's package.json. Backs up the original file
# to <path>.bak before modifying.
resolve_workspace_deps() {
  local pkg_json="$1"
  cp "$pkg_json" "$pkg_json.bak"

  node -e "
    const fs = require('fs');
    const path = require('path');

    // Build a map of workspace package names to their actual versions
    const workspaceDirs = $(printf "'%s'," "${PACKAGES[@]}" | sed 's/,$//; s/^/[/; s/$/]/')
    const versions = {};
    for (const dir of workspaceDirs) {
      try {
        const wp = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        versions[wp.name] = wp.version;
      } catch {}
    }

    // Resolve workspace:* references in the target package.json
    const pkg = JSON.parse(fs.readFileSync('$pkg_json', 'utf8'));
    let changed = false;
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[depType];
      if (!deps) continue;
      for (const [name, value] of Object.entries(deps)) {
        if (typeof value === 'string' && value.startsWith('workspace:')) {
          const resolved = versions[name];
          if (resolved) {
            deps[name] = resolved;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      fs.writeFileSync('$pkg_json', JSON.stringify(pkg, null, 2) + '\n');
    }
  "
}

# restore_package_json <package.json path>
#
# Restores the original package.json from the .bak copy.
restore_package_json() {
  local pkg_json="$1"
  if [ -f "$pkg_json.bak" ]; then
    mv "$pkg_json.bak" "$pkg_json"
  fi
}

# Restore any .bak files on exit (in case the script is interrupted between
# resolve_workspace_deps and restore_package_json).
cleanup() {
  for pkg_dir in "${PACKAGES[@]}"; do
    if [ -f "$pkg_dir/package.json.bak" ]; then
      mv "$pkg_dir/package.json.bak" "$pkg_dir/package.json"
    fi
  done
}
trap cleanup EXIT

published=0
failed=0

for pkg_dir in "${PACKAGES[@]}"; do
  if [ ! -f "$pkg_dir/package.json" ]; then
    echo "Skipping $pkg_dir (no package.json)"
    continue
  fi

  name=$(node -e "console.log(require('./$pkg_dir/package.json').name)")
  version=$(node -e "console.log(require('./$pkg_dir/package.json').version)")
  private=$(node -e "console.log(require('./$pkg_dir/package.json').private || false)")

  if [ "$private" = "true" ]; then
    echo "Skipping $name (private)"
    continue
  fi

  # Check if this version is already published
  existing=$(npm view "$name@$version" version 2>/dev/null || echo "")
  if [ "$existing" = "$version" ]; then
    echo "Skipping $name@$version (already published)"
    continue
  fi

  echo "Publishing $name@$version from $pkg_dir..."

  # Step 1: Resolve workspace:* to real versions and pack
  resolve_workspace_deps "$pkg_dir/package.json"
  tarball=$(cd "$pkg_dir" && bun pm pack 2>&1 | grep '\.tgz$' | tr -d '[:space:]') || true
  restore_package_json "$pkg_dir/package.json"

  if [ -z "$tarball" ] || [ ! -f "$pkg_dir/$tarball" ]; then
    echo "Failed to pack $name@$version"
    failed=$((failed + 1))
    continue
  fi

  # Step 2: Publish the tarball with npm (uses .npmrc for auth)
  if npm publish "$pkg_dir/$tarball" --access public; then
    echo "Published $name@$version"
    published=$((published + 1))

    # Create a git tag matching Changesets convention
    tag="$name@$version"
    git tag -a "$tag" -m "$tag" 2>/dev/null || echo "Tag $tag already exists"

    # Clean up tarball
    rm -f "$pkg_dir/$tarball"
  else
    echo "Failed to publish $name@$version"
    rm -f "$pkg_dir/$tarball"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Published: $published, Failed: $failed"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
