# Historical artifact preparation

The P0 catalog records source facts separately from runtime qualification. `build.ts`
prepares one catalog entry without checking out the historical commit in the current
worktree and without editing any historical file.

Run it with an output directory outside the repository:

```bash
bun packages/lab/src/cli.ts prepare \
  --artifact dwn-server-0.1.43 \
  --output /tmp/enbox-lab-artifacts \
  --json
```

The preparation path is derived from the artifact ID and a SHA-256 build key covering
the source commit and tree, dependency lock, Dockerfile pin, Bun toolchain, install
command, and base-image inventory. Source is exported with `git archive`; the harness
never calls `git checkout` or `git worktree` and rejects direct, symlinked, and dangling
symlink output paths that lead into the repository. It retains one sealed source tar
per build key and removes the temporary extracted tree after each run.

Before Docker is called, the harness verifies:

- the catalog's commit, tree, source objects, package source trees, package versions,
  Bun version, and lock bytes against the local Git object database;
- the materialized `bun.lock` SHA-256 and format version;
- the complete sealed context against the pinned Git tree, including file modes and
  symbolic links;
- that the catalog install command uses `--frozen-lockfile` and that the pinned
  Dockerfile actually invokes that command;
- that every external `FROM` instruction contains its cataloged `sha256` digest.

The last rule deliberately blocks the current 0.1.42 and 0.1.43 candidates. Their
historical Dockerfile uses `oven/bun:1-alpine`, and the catalog has no immutable digest.
They currently return `unsupported` after producing a verified source archive. The
harness does not rewrite `FROM`, resolve today's mutable tag, or describe such a build
as historical qualification.

For an eligible recipe, Docker receives the same sealed tar bytes that passed the tree
check and builds an initially untagged image with closure labels. The harness rebuilds
before trusting any prior local result, derives a convenience tag from both the build
key and resulting image ID, checks the tag before and after assignment, and reports the
image's `sha256:...` ID as the immutable local reference. Docker has no atomic
no-clobber tag operation, so consumers use the image ID for identity; the tag is only a
local lookup aid. A successful image build still does not qualify private DID
configuration, connect, sync, forwarding, runtime behavior, or platform support.

Exit codes are `0` for a prepared image, `1` for a failed integrity/build check, and
`2` for an unsupported immutable recipe (as well as command-line usage errors). The
JSON output is the evidence record for this preparation step and includes the retained
sealed source archive. Preparation may access registries while Docker builds; later offline
runtime behavior is outside this harness.
