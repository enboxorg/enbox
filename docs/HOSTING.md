# Hosting a DWN Server

This guide covers running a remote DWN server for production or development use.

## Docker Compose

The easiest way to run a remote DWN server. The compose file sets up both the DWN server and PostgreSQL.

```bash
# From the packages/dwn-server directory
docker compose up -d

# View logs
docker compose logs -f dwn-server

# Stop
docker compose down
```

The DWN server will be available at `http://localhost:3000`.

See [`packages/dwn-server/docker-compose.yaml`](../packages/dwn-server/docker-compose.yaml) for the full compose configuration.

## Configuration

Copy `docker.env.example` to `.env` and customize:

```bash
cp docker.env.example .env
```

Key settings:

| Variable | Default | Description |
|---|---|---|
| `DWN_SERVER_PORT` | `3000` | DWN server port |
| `DWN_BASE_URL` | `http://localhost:3000` | Public URL (used for Enbox Connect flows) |
| `POSTGRES_DB` | `dwn` | Database name |
| `POSTGRES_USER` | `dwn_user` | Database user |
| `POSTGRES_PASSWORD` | `dwn_password` | Database password (change in production) |
| `MAX_RECORD_DATA_SIZE` | `1gb` | Maximum record data size |
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
6. **Enable registration** -- configure proof-of-work or terms-of-service tenant registration

## Self-Hosting Anywhere

To deploy your own DWN on any host (cloud provider, VPS, Kubernetes, or a home server behind a tunnel) — including how to advertise the node in your DID document — see the complete [Self-Hosting Guide](../SELF-HOSTING.md).
