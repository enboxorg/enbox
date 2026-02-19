# Fly.io Deployment Guide

Deploy your DWN server to Fly.io with managed PostgreSQL.

## Prerequisites

- [Fly.io account](https://fly.io)
- [Fly CLI (`flyctl`)](https://fly.io/docs/flyctl/install/) installed
- Authenticated: `fly auth login`

## Quick Start

### 1. Prepare Repository
```bash
# Fork this repository to your GitHub account
# Clone your fork locally
git clone https://github.com/YOUR_USERNAME/enbox.git
cd enbox
```

### 2. Create the Fly App
```bash
# Create the app (or let fly.toml define it)
fly apps create enbox-dwn
```

### 3. Create and Attach PostgreSQL
```bash
# Create a Fly Postgres cluster
fly postgres create --name enbox-db

# Attach it to the DWN server app
fly postgres attach enbox-db -a enbox-dwn
```

The `DATABASE_URL` secret is automatically added to your app.

### 4. Configure Secrets

Set the database connection for all DWN storage backends. Use the `DATABASE_URL` value from step 3:

```bash
# Get the DATABASE_URL value
fly secrets list -a enbox-dwn

# Set storage secrets (replace <DATABASE_URL> with the actual value)
fly secrets set \
  DWN_TTL_CACHE_URL="<DATABASE_URL>" \
  DWN_STORAGE_MESSAGES="<DATABASE_URL>" \
  DWN_STORAGE_DATA="<DATABASE_URL>" \
  DWN_STORAGE_STATE_INDEX="<DATABASE_URL>" \
  DWN_STORAGE_RESUMABLE_TASKS="<DATABASE_URL>" \
  -a enbox-dwn
```

Non-secret environment variables are already configured in `fly.toml` under `[env]`.

### 5. Deploy
```bash
fly deploy
```

### 6. Verify
```bash
# Check app status
fly status -a enbox-dwn

# Test the info endpoint
curl https://enbox-dwn.fly.dev/info

# Test the health endpoint
curl https://enbox-dwn.fly.dev/health
```

## Configuration Details

### Environment Variables

#### Set in `fly.toml` `[env]` (non-secret)

| Variable | Default | Description |
|----------|---------|-------------|
| `DS_PORT` | `8080` | Server port (must match `internal_port` in fly.toml) |
| `DWN_BASE_URL` | `https://enbox-dwn.fly.dev` | Public URL of your service |
| `DS_WEBSOCKET_SERVER` | `on` | Enable WebSocket support |
| `MAX_RECORD_DATA_SIZE` | `1gb` | Maximum record size |
| `DWN_SERVER_LOG_LEVEL` | `info` | Logging level |

#### Set via `fly secrets set` (sensitive)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (auto-set by `fly postgres attach`) |
| `DWN_TTL_CACHE_URL` | PostgreSQL URL for TTL cache |
| `DWN_STORAGE_MESSAGES` | PostgreSQL URL for message storage |
| `DWN_STORAGE_DATA` | PostgreSQL URL for data storage |
| `DWN_STORAGE_STATE_INDEX` | PostgreSQL URL for state index (sync state) |
| `DWN_STORAGE_RESUMABLE_TASKS` | PostgreSQL URL for resumable task storage |

### Fly.io Auto-Provided Variables

Fly.io automatically provides:
- `FLY_APP_NAME` - Your app name
- `FLY_REGION` - The region the machine is running in
- `FLY_MACHINE_ID` - The machine identifier
- `PRIMARY_REGION` - The primary region configured in fly.toml

## Production Setup

### Custom Domain
```bash
# Add a custom domain
fly certs add your-domain.com -a enbox-dwn

# Show DNS configuration instructions
fly certs show your-domain.com -a enbox-dwn
```

Update `DWN_BASE_URL` in `fly.toml` to match your custom domain.

### Scaling

```bash
# Scale to multiple machines
fly scale count 2 -a enbox-dwn

# Scale machine size
fly scale vm shared-cpu-2x -a enbox-dwn

# Scale memory
fly scale memory 1024 -a enbox-dwn
```

### Health Checks and Monitoring

Fly.io automatically monitors your service health via the configured HTTP check on `/health`.

```bash
# View app status
fly status -a enbox-dwn

# View live logs
fly logs -a enbox-dwn

# Open monitoring dashboard
fly dashboard -a enbox-dwn
```

### Metrics

The DWN server exposes Prometheus metrics at `/metrics`. You can configure Fly.io's built-in metrics or use an external Prometheus/Grafana setup.

## CI/CD with GitHub Actions

Automated deployment is configured in `.github/workflows/deploy.yml`. It:
1. Runs the full CI test suite
2. Deploys to Fly.io on push to `main`

### Setup

1. Generate a Fly.io deploy token:
   ```bash
   fly tokens create deploy -a enbox-dwn
   ```

2. Add the token as a GitHub repository secret:
   - Go to your repo **Settings** > **Secrets and variables** > **Actions**
   - Add `FLY_API_TOKEN` with the token value

## Development Workflow

### Local Development with Fly Postgres

```bash
# Proxy to the Fly Postgres database locally
fly proxy 15432:5432 -a enbox-db

# In another terminal, start local development
DS_PORT=3000 \
DWN_BASE_URL=http://localhost:3000 \
DWN_TTL_CACHE_URL=postgres://user:pass@localhost:15432/db \
DWN_STORAGE_MESSAGES=postgres://user:pass@localhost:15432/db \
DWN_STORAGE_DATA=postgres://user:pass@localhost:15432/db \
DWN_STORAGE_STATE_INDEX=postgres://user:pass@localhost:15432/db \
DWN_STORAGE_RESUMABLE_TASKS=postgres://user:pass@localhost:15432/db \
bun run server
```

### Testing Docker Build Locally
```bash
# Build the Docker image locally
docker build -f packages/dwn-server/Dockerfile -t dwn-server .

# Run with local environment
docker run -p 3000:3000 \
  -e DS_PORT=3000 \
  -e DWN_BASE_URL=http://localhost:3000 \
  dwn-server
```

## Troubleshooting

### Common Issues

#### Build Failures
```bash
# View build logs
fly logs -a enbox-dwn

# Rebuild from scratch
fly deploy --remote-only --no-cache
```

#### Database Connection Issues
```bash
# Verify Postgres is running
fly status -a enbox-db

# Check secrets are set
fly secrets list -a enbox-dwn

# Connect to Postgres directly
fly postgres connect -a enbox-db
```

#### Port Issues
- Ensure `DS_PORT` in `[env]` matches `internal_port` in `[[http_service]]`
- Default: `8080`

#### Registration Errors
- Ensure `DWN_REGISTRATION_STORE_URL` is NOT set
- Don't use `DWN_STORAGE` variable (causes registration fallback)

### SSH Access
```bash
# SSH into the running machine
fly ssh console -a enbox-dwn
```

## Additional Resources

- [Fly.io Documentation](https://fly.io/docs/)
- [Fly.io CLI Reference](https://fly.io/docs/flyctl/)
- [Fly Postgres](https://fly.io/docs/postgres/)
- [DWN Server Documentation](./packages/dwn-server/README.md)

## Next Steps

After successful deployment:

1. **Test the deployment:**
   ```bash
   curl https://enbox-dwn.fly.dev/info
   ```

2. **Set up monitoring** via Fly.io dashboard

3. **Configure custom domain** for production

4. **Set up CI/CD** with GitHub Actions (see above)

5. **Scale** your service based on usage
