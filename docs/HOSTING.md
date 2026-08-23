# Hosting a DWN Server

This guide covers running a remote DWN server for production or development use.

## Docker Compose

The easiest way to run a DWN server. The compose file starts the full stack: the DWN server (built from source), PostgreSQL, a did:dht gateway (Pkarr relay), and NATS.

```bash
# From the packages/dwn-server directory
docker compose up -d --build

# View logs
docker compose logs -f dwn-server

# Stop
docker compose down
```

The DWN server will be available at `http://localhost:3000`.

See [`packages/dwn-server/docker-compose.yaml`](../packages/dwn-server/docker-compose.yaml) for the full compose configuration, and [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) for development workflows (hot-reload container and running the server natively against the compose stack).

## Configuration

The compose file is fully configured out of the box — `docker compose up -d` works with no extra files. To customize, drop a `.env` beside the compose file (or export variables in your shell); every value is wired through `${VAR:-default}`:

```bash
# packages/dwn-server/.env
DWN_SERVER_PORT=3000
DWN_BASE_URL=https://dwn.example.com
POSTGRES_DB=dwn
POSTGRES_USER=dwn_user
POSTGRES_PASSWORD=change-me-in-production
```

| Variable | Default | Description |
|---|---|---|
| `DWN_SERVER_PORT` | `3000` | Host port for the DWN server |
| `DWN_BASE_URL` | `http://localhost:${DWN_SERVER_PORT:-3000}` | Public URL (used for Enbox Connect flows) |
| `DWN_POSTGRES_PORT` | `5433` | Host port for PostgreSQL (5433 to avoid colliding with the test stack's Postgres on 5432) |
| `POSTGRES_DB` | `dwn` | Database name |
| `POSTGRES_USER` | `dwn_user` | Database user |
| `POSTGRES_PASSWORD` | `dwn_password` | Database password (change in production) |
| `DID_DHT_GATEWAY_PORT` | `7527` | Host port for the did:dht gateway (Pkarr relay) |
| `DWN_NATS_PORT` | `4222` | Host port for NATS |
| `MAX_RECORD_DATA_SIZE` | `100mb` | Maximum record data size accepted by the server |
| `DWN_ADMIN_TOKEN` | `dev-admin-token` in the local compose (override or blank to disable) | Bearer token enabling the admin API/UI and protecting `/metrics` |
| `DWN_REGISTRATION_PROOF_OF_WORK_ENABLED` | `true` in the local compose | Require proof-of-work for tenant registration |
| `DWN_SERVER_LOG_LEVEL` | `DEBUG` | Log level (`trace`/`debug`/`info`/`warn`/`error`) |

> The local stack mounts a placeholder terms-of-service file (`packages/dwn-server/terms-of-service.dev.txt`) so the registration flow works end-to-end. For a real deployment, supply your own ToS and review all registration settings — see [Registration requirements](../packages/dwn-server/README.md#registration-requirements).

For everything else — storage backends, admin API, tenant registration, provider auth, plugins — see the configuration tables in the [`@enbox/dwn-server` README](../packages/dwn-server/README.md), and pass additional entries through the compose file's `environment:` block.

Backend drivers are optional. LevelDB and SQLite need no extra packages; PostgreSQL
deployments must include `pg` and `pg-cursor`, MySQL deployments must include
`mysql2`, and the NATS event-bus plugin needs `@nats-io/transport-node`.

## Production Considerations

1. **Change default passwords** -- use Docker secrets or external secret management
2. **Use external PostgreSQL** for better scalability and managed backups
3. **Set up SSL/TLS termination** via a reverse proxy (nginx, Caddy, etc.)
4. **Configure backup strategies** for PostgreSQL data
5. **Set resource limits** for containers
6. **Enable registration** -- configure proof-of-work or terms-of-service tenant registration

## Self-Hosting Anywhere

To deploy your own DWN on any host (cloud provider, VPS, Kubernetes, or a home server behind a tunnel) — including how to advertise the node in your DID document — see the complete [Self-Hosting Guide](../SELF-HOSTING.md).
