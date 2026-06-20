# Contributing to `@enbox/dwn-server`

General contributor workflow, style, testing, and release rules are maintained
at the repository root in [AGENTS.md](../../AGENTS.md). Use that file as the
source of truth for this package.

Useful package commands:

```bash
bun run build
bun run lint
bun run lint:fix
bun run test:node
```

Server tests that use PostgreSQL, NATS, MinIO, or DID:DHT publishing require
the shared local services described in [docs/TESTING.md](../../docs/TESTING.md).
