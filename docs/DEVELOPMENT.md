# Local Development

This guide covers running and iterating on `@enbox/dwn-server` locally with Docker Compose. For deploying to production, see [HOSTING.md](HOSTING.md); for running test suites, see [TESTING.md](TESTING.md).

## The stack

`packages/dwn-server/docker-compose.yaml` starts four services:

| Service | Container | Host port | Purpose |
|---|---|---|---|
| DWN server | `dwn-server` | `${DWN_SERVER_PORT:-3000}` | Built from source into an image |
| PostgreSQL | `dwn-server-postgres` | `${DWN_POSTGRES_PORT:-5433}` | Message/data/resumable-task/registration stores + TTL cache |
| did:dht gateway | `dwn-server-pkarr` | `${DID_DHT_GATEWAY_PORT:-7527}` | Pkarr relay for DID publishing (`--testnet`) |
| NATS | `dwn-server-nats` | `${DWN_NATS_PORT:-4222}` | Cross-process event-bus wakes via the bundled NATS plugin |

Everything is wired out of the box — no `.env` required to start. Defaults can be overridden by dropping a `.env` beside the compose file or exporting variables; see [HOSTING.md](HOSTING.md#configuration) for the table.

> Postgres defaults to host port **5433** so it never collides with `enbox-test-postgres-sdk` from [`docker-compose.test.yaml`](../docker-compose.test.yaml), which binds **5432**.

## Workflows

### 1. Full stack from an image (prod-like)

```bash
cd packages/dwn-server
docker compose up -d --build

docker compose logs -f dwn-server
curl http://localhost:3000/info
```

Use this when you want to run the server exactly as deployed. Source changes require a rebuild.

### 2. Hot-reload container (watch mode)

```bash
cd packages/dwn-server
docker compose -f docker-compose.yaml -f docker-compose.watch.yaml up -d --build
```

The override replaces the image's prebuilt entrypoint with a bind mount of the monorepo plus `bun --watch src/main.ts`, mirroring what `scripts/dev.sh` does natively:

- Edits to `packages/dwn-server/src/**` reload live — no build step.
- The first start runs `bun install` and a Turbo build of dwn-server's workspace dependencies inside the container (one-time; cached in a named volume and the host Turbo cache afterwards).
- The container shares your working tree, so `dist/` artifacts are the same ones native development uses.

> **Platform caveat:** live reload depends on file-watch events crossing the bind mount, which only works on **Linux** hosts. On macOS and Windows, Docker Desktop does not propagate host file events into the VM, so edits go unnoticed until the process restarts — use workflow 3 (native server) on those platforms instead.

Switching between modes is just `down` + `up` with (or without) the override file.

### 3. Native server against compose infrastructure (fastest iteration)

Run only the backing services in Docker and the server directly on the host:

```bash
cd packages/dwn-server
docker compose up -d postgres pkarr-relay nats

DWN_STORAGE=postgres://dwn_user:dwn_password@localhost:5433/dwn \
DWN_TTL_CACHE_URL=postgres://dwn_user:dwn_password@localhost:5433/dwn \
DID_DHT_GATEWAY_URI=http://localhost:7527 \
DID_DHT_ALLOW_PRIVATE_GATEWAY=1 \
NATS_URL=nats://localhost:4222 \
DWN_EVENT_BUS_PLUGIN_PATH="$(pwd)/src/plugins/event-bus-nats.ts" \
DS_PORT=3000 \
bun --watch src/main.ts
```

This requires Bun on the host but has zero image-build overhead and the tightest edit-to-reload loop. Workspace dependencies must be built once first (`bunx turbo run build --filter=@enbox/dwn-server` from the repo root).

### Relationship to `scripts/dev.sh`

`scripts/dev.sh` (repo root) is the blessed one-command environment for *running tests*: it starts a did:dht gateway, runs the DWN server from source over ephemeral LevelDB, and writes `.env.test` files. It composes cleanly with this stack:

- Its gateway check probes `http://localhost:7527` first, so if this compose stack is up, `dev.sh` reuses its Pkarr relay instead of starting another.
- Conversely, `dev.sh` always runs its own server with LevelDB storage — it does not use the compose Postgres. Use workflow 2 or 3 above when you specifically want to develop against SQL storage.

## Common tasks

```bash
# Reset the database (destroys all data)
docker compose down -v

# Reset only the hot-reload dependency cache
docker compose down && docker volume rm dwn-server_dwn-watch-node-modules

# Shell into the server container
docker compose exec dwn-server bash

# Change ports / credentials without editing the file
echo 'DWN_SERVER_PORT=4000' >> .env && docker compose up -d
```
