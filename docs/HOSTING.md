# Hosting a DWN Server

This guide covers running a remote DWN server for production or development use.

## Local Docker Compose

The package Compose file runs a LevelDB-backed development node. It deliberately
requires you to acknowledge its open, unbounded posture before it will start.

```bash
cp docker.env.example packages/dwn-server/.env
# In packages/dwn-server/.env, set both DWN_ALLOW_* values to true for local development.
cd packages/dwn-server
docker compose up -d

# View logs
docker compose logs -f dwn-server

# Stop
docker compose down
```

The DWN server will be available at `http://localhost:3000`.

See [`packages/dwn-server/docker-compose.yaml`](../packages/dwn-server/docker-compose.yaml) for the full compose configuration.

## Configuration

Copy the repository example into the package directory and customize it:

```bash
cp docker.env.example packages/dwn-server/.env
```

Key settings:

| Variable | Default | Description |
|---|---|---|
| `DWN_SERVER_PORT` | `3000` | DWN server port |
| `DWN_BASE_URL` | `http://localhost:3000` | Public URL (used for Enbox Connect flows) |
| `POSTGRES_DB` | `dwn` | Database name |
| `POSTGRES_USER` | `dwn_user` | Database user |
| `POSTGRES_PASSWORD` | `dwn_password` | Database password (change in production) |
| `MAX_RECORD_DATA_SIZE` | `100mb` | Startup-only maximum record data size |
| `DWN_WEBSOCKET_MAX_CONNECTIONS` | `1000` | Startup-only process-wide WebSocket connection limit |
| `DWN_WEBSOCKET_MAX_CONNECTIONS_PER_IP` | `100` | Startup-only connection limit per peer IP |
| `DWN_WEBSOCKET_MAX_SUBSCRIPTIONS_PER_CONNECTION` | `64` | Startup-only outstanding subscription-slot limit per connection |
| `DWN_ALLOW_OPEN_TENANTS` | `false` | Explicitly allow a remote server without a tenant gate |
| `DWN_ALLOW_UNBOUNDED_TENANT_USAGE` | `false` | Explicitly allow either quota dimension to be unlimited |
| `DWN_PUBLIC_METRICS_ENABLED` | `false` | Expose `/metrics` without admin authentication |
| `LOG_LEVEL` | -- | Set to `debug` for verbose logging |

See the [`@enbox/dwn-server` README](../packages/dwn-server/README.md) for the full list of configuration options, storage backends, plugin system, and JSON-RPC API documentation.

Backend drivers are optional. LevelDB and SQLite need no extra packages; PostgreSQL
deployments must include `pg` and `pg-cursor`, MySQL deployments must include
`mysql2`, and the NATS event-bus plugin needs `@nats-io/transport-node`.

## Production Considerations

1. **Change default passwords** -- use Docker secrets or external secret management
2. **Use external PostgreSQL** for better scalability and managed backups
3. **Set up SSL/TLS termination** via a reverse proxy (nginx, Caddy, etc.)
4. **Configure backup strategies** for PostgreSQL data
5. **Set resource limits** for containers
6. **Enable registration** -- configure proof-of-work/provider auth or pre-register tenants
7. **Set both finite quota defaults** -- SQL message storage is required for usage accounting
8. **Keep metrics private** -- configure `DWN_ADMIN_TOKEN` for authenticated scraping

Enbox keys peer-IP limits from the direct TCP peer and does not trust forwarded
headers. When a reverse proxy terminates client connections, enforce client-IP
admission there and size Enbox's per-peer limit for the proxy's aggregate traffic.

## Self-Hosting Anywhere

To deploy your own DWN on any host (cloud provider, VPS, Kubernetes, or a home server behind a tunnel) — including how to advertise the node in your DID document — see the complete [Self-Hosting Guide](../SELF-HOSTING.md).
