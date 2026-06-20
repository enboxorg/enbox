# Contributing to `@enbox/dwn-sdk-js`

General contributor workflow, style, testing, and release rules are maintained
at the repository root in [AGENTS.md](../../AGENTS.md). `@enbox/dwn-sdk-js` is
the reference package for repo style, so new code should match its existing
module layout, error handling, test shape, and lint conventions.

Useful package commands:

```bash
bun run build
bun run lint
bun run lint:fix
bun run test:node
GREP="RecordsReadHandler" bun run test:node-grep
BROWSER=chromium bun run test:browser
```

For local services and browser-test setup, see
[docs/TESTING.md](../../docs/TESTING.md). General DWN specification questions
belong in the upstream Decentralized Web Node specification work rather than in
package-local implementation notes.
