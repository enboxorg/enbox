# Railway Deployment Guide

Deploy your DWN server to Railway with managed PostgreSQL in minutes.

## 🚀 **Quick Start**

### 1. Prepare Repository
```bash
# Fork this repository to your GitHub account
# Clone your fork locally
git clone https://github.com/YOUR_USERNAME/enbox.git
cd enbox
```

### 2. Deploy to Railway

#### Manual Setup
1. Visit [railway.app](https://railway.app) and sign up/login
2. Create **New Project** → **Deploy from GitHub repo**
3. Select your forked `enbox` repository
4. Railway will automatically detect the `railway.json` configuration

### 3. Add PostgreSQL Database
1. In your Railway project dashboard, click **"New Service"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway automatically creates and connects the database
4. `DATABASE_URL` will be available as an environment variable

### 4. Configure Environment Variables
**CRITICAL**: You must manually set these environment variables in Railway dashboard:

Go to your DWN service → **Variables** tab and add these variables **exactly**:

```bash
# Required Variables (use Railway service reference syntax)
DS_PORT = ${{PORT}}
DWN_BASE_URL = https://your-service-name.up.railway.app
DWN_TTL_CACHE_URL = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_MESSAGES = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_DATA = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_EVENTS = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_RESUMABLE_TASKS = ${{Postgres.DATABASE_URL}}

# Optional Variables
DS_WEBSOCKET_SERVER = on
MAX_RECORD_DATA_SIZE = 1gb
DWN_SERVER_LOG_LEVEL = info
```

### 5. Deploy & Verify
- Railway automatically builds and deploys your service
- Check the **Deployments** tab for build progress
- Visit your service URL to verify deployment
- Test the `/info` endpoint: `https://your-service.railway.app/info`

## 🔧 **Configuration Details**

### Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `DS_PORT` | Server port (use Railway's `$PORT`) | `$PORT` |
| `DWN_BASE_URL` | Public URL of your service | `https://my-dwn.railway.app` |
| `DWN_TTL_CACHE_URL` | PostgreSQL for TTL cache | `$DATABASE_URL` |
| `DWN_STORAGE_*` | PostgreSQL for all storage | `$DATABASE_URL` |
| `DS_WEBSOCKET_SERVER` | Enable WebSocket support | `on` |
| `MAX_RECORD_DATA_SIZE` | Maximum record size | `1gb` |
| `DWN_SERVER_LOG_LEVEL` | Logging level | `info` or `debug` |

### Railway Auto-Provided Variables
Railway automatically provides these:
- `PORT` - The port your service should listen on
- `DATABASE_URL` - PostgreSQL connection string
- `RAILWAY_ENVIRONMENT` - Environment name (production, staging)
- `RAILWAY_SERVICE_NAME` - Your service name
- `RAILWAY_PROJECT_NAME` - Your project name

## 🏗️ **Production Setup**

### Custom Domain
1. In Railway dashboard → **Settings** → **Domains**
2. Add your custom domain
3. Update `DWN_BASE_URL` to match your domain
4. Configure DNS records as shown

### Environment Management
```bash
# Create staging environment
railway environment create staging

# Create production environment  
railway environment create production

# Deploy to specific environment
railway up --environment production
```

### Health Checks & Monitoring
Railway automatically monitors your service health via the `/info` endpoint.

To add custom health checks:
```bash
# Add to your environment variables
HEALTH_CHECK_PATH=/health
```

### Scaling & Performance
```toml
# In railway.toml
[deploy]
numReplicas = 2           # Scale horizontally
restartPolicyType = "on_failure"
```

## 🛠️ **Development Workflow**

### Local Development with Railway Database
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Link to your project
railway link

# Pull environment variables
railway env

# Start local development with Railway variables
railway run pnpm dev
```

### Testing Railway Configuration Locally
```bash
# Build the Docker image locally
docker build -f packages/dwn-server/Dockerfile -t dwn-server .

# Run with Railway-like environment
docker run -p 3000:3000 \
  -e DS_PORT=3000 \
  -e DWN_BASE_URL=http://localhost:3000 \
  -e DATABASE_URL=postgresql://user:password@localhost:5432/dwn \
  dwn-server
```

## 🔍 **Troubleshooting**

### Common Issues

#### Build Failures
- Check **Deployments** tab for build logs
- Ensure `packages/dwn-server/Dockerfile` exists
- Verify monorepo structure is intact

#### Database Connection Issues
- Verify PostgreSQL service is running
- Check `DATABASE_URL` is set correctly
- Ensure all `DWN_STORAGE_*` variables use `$DATABASE_URL`

#### Port Issues
- Always use `DS_PORT=$PORT` (not hardcoded port)
- Railway expects your app to listen on `$PORT`

#### Registration Errors
- Ensure `DWN_REGISTRATION_STORE_URL` is NOT set
- Don't use `DWN_STORAGE` variable (causes registration fallback)

### Debugging
```bash
# View live logs
railway logs

# Connect to production environment
railway connect

# Run commands in production context
railway run bash
```

## 📚 **Additional Resources**

- [Railway Documentation](https://docs.railway.app)
- [Railway Templates](https://railway.app/templates)
- [Railway CLI Reference](https://docs.railway.app/develop/cli)
- [DWN Server Documentation](./packages/dwn-server/README.md)

## 🎯 **Next Steps**

After successful deployment:

1. **Test the deployment:**
   ```bash
   curl https://your-service.railway.app/info
   ```

2. **Set up monitoring** via Railway dashboard

3. **Configure custom domain** for production

4. **Set up CI/CD** with GitHub Actions

5. **Scale** your service based on usage

Your DWN server is now ready for production use! 🎉