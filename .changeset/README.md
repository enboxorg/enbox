# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.

## Adding a changeset

When you make a change that should be published, run:

```bash
bun changeset
```

This will prompt you to select the packages affected and the type of version bump (patch, minor, major).

## How it works

1. PRs that change published packages should include a changeset file.
2. When PRs with changesets merge to `main`, the Release workflow creates a "Version Packages" PR that batches all pending version bumps.
3. Merging that PR publishes the new versions to npm and creates GitHub releases.
