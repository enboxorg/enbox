#!/bin/bash
set -e

# Custom publish script that uses `bun publish` instead of `changeset publish`.
#
# Changesets' built-in publish uses `npm publish` which does NOT resolve Bun's
# `workspace:*` protocol in dependencies. This results in broken packages on npm
# that contain literal "workspace:*" strings. Bun's publish command resolves
# workspace references to actual version numbers before publishing.
#
# This script:
# 1. Checks each public package to see if its current version is already on npm
# 2. If not published yet, runs `bun publish` (which resolves workspace:*)
# 3. Creates git tags in the format expected by Changesets

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

  name=$(bun -e "console.log(require('./$pkg_dir/package.json').name)")
  version=$(bun -e "console.log(require('./$pkg_dir/package.json').version)")
  private=$(bun -e "console.log(require('./$pkg_dir/package.json').private || false)")

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
  if (cd "$pkg_dir" && bun publish --access public); then
    echo "Published $name@$version"
    published=$((published + 1))

    # Create a git tag matching Changesets convention
    tag="$name@$version"
    git tag -a "$tag" -m "$tag" 2>/dev/null || echo "Tag $tag already exists"
  else
    echo "Failed to publish $name@$version"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Published: $published, Failed: $failed"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
