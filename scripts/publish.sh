#!/bin/bash
set -e

# Changesets Action v2 reads structured receipts instead of stdout markers.
# Check the destination before publishing and discard receipts from earlier runs.
if [ -n "${CHANGESETS_OUTPUT:-}" ]; then
  : > "$CHANGESETS_OUTPUT"
fi

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
# npm publishes the tested archives with registry authentication and provenance.

PACKAGES=(
  "packages/common"
  "packages/crypto"
  "packages/dids"
  "packages/dwn-sdk-js"
  "packages/connect"
  "packages/dwn-clients"
  "packages/agent"
  "packages/auth"
  "packages/api"
  "packages/protocols"
  "packages/protocol-codegen"
  "packages/browser"
  "packages/cli"
  "packages/dwn-sql-store"
  "packages/dwn-server-admin-ui"
  "packages/dwn-server"
  "packages/local-node"
)

# resolve_workspace_deps <package.json path>
#
# Replaces "workspace:*" dependency values with the actual version from the
# corresponding workspace package's package.json and records the release commit.
# Backs up the original file to <path>.bak before modifying.
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
    pkg.gitHead = process.argv[1];
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[depType];
      if (!deps) continue;
      for (const [name, value] of Object.entries(deps)) {
        if (typeof value === 'string' && value.startsWith('workspace:')) {
          const resolved = versions[name];
          if (resolved) {
            deps[name] = resolved;
          }
        }
      }
    }
    fs.writeFileSync('$pkg_json', JSON.stringify(pkg, null, 2) + '\n');
  " "$release_commit"
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
release_commit=$(git rev-parse --verify HEAD)

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

  # Prepare the tag before publishing so a Git failure cannot strand an npm release.
  tag="$name@$version"
  # Shallow checkouts must fetch the original remote tag object before validating it.
  if git ls-remote --exit-code --refs origin "refs/tags/$tag" > /dev/null; then
    git fetch --no-tags origin "refs/tags/$tag:refs/tags/$tag"
  else
    remote_tag_status=$?
    if [ "$remote_tag_status" -ne 2 ]; then
      exit "$remote_tag_status"
    fi
  fi

  if git show-ref --verify --quiet "refs/tags/$tag"; then
    tagged_commit=$(git rev-parse --verify "refs/tags/$tag^{commit}")
    current_commit=$(git rev-parse --verify HEAD)
    if [ "$tagged_commit" != "$current_commit" ]; then
      echo "Tag $tag already exists at a different commit" >&2
      exit 1
    fi
  else
    git tag -a "$tag" -m "$tag"
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
  if npm publish "$pkg_dir/$tarball" --access public --provenance; then
    echo "Published $name@$version"
    published=$((published + 1))

    # Keep the human-readable marker and report successful releases to Action v2.
    echo "New tag: $tag"
    if [ -n "${CHANGESETS_OUTPUT:-}" ]; then
      node -e '
        const fs = require("node:fs");
        const event = {
          type        : "git-tag",
          tag         : process.argv[2],
          packageName : process.argv[1],
        };
        fs.appendFileSync(process.env.CHANGESETS_OUTPUT, JSON.stringify(event) + "\n");
      ' "$name" "$tag"
    fi

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
