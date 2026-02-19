#!/bin/bash
set -e

# Custom publish script that resolves Bun's workspace:* protocol before publishing.
#
# Changesets' built-in publish uses `npm publish` directly on the package
# directory, which does NOT resolve Bun's `workspace:*` protocol — resulting
# in broken packages on npm with literal "workspace:*" strings.
#
# This script uses a two-step approach:
# 1. `bun pm pack` — creates a tarball with workspace:* resolved to real versions
# 2. `npm publish <tarball>` — publishes the tarball (npm handles auth via .npmrc)
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
  "packages/agent"
  "packages/api"
  "packages/browser"
  "packages/dwn-sql-store"
)

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

  # Step 1: Pack with bun (resolves workspace:* to actual versions)
  tarball=$(cd "$pkg_dir" && bun pm pack 2>&1 | grep '\.tgz$' | tr -d '[:space:]')
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
