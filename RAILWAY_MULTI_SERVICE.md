# Railway Multi-Service Deployment Guide

This guide explains how to deploy dwn-server, web-wallet, and dapp-demo from this monorepo to Railway.

## Overview

Since web-wallet and dapp-demo have been moved from separate repositories into the `examples/` folder of this monorepo, we need to set up Railway to deploy all three services from a single repository.

## Step 1: Clean Up Old Deployments

If you have existing Railway projects for web-wallet and dapp-demo from their old repositories:

1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. For each old project (web-wallet and dapp-demo):
   - Click on the project
   - Go to Settings → Danger Zone
   - Click "Delete Project"

## Step 2: Set Up Multi-Service Deployment

Railway supports multiple services in a monorepo. Here's how to set it up:

### Option A: Using Railway UI (Recommended)

1. **Create New Project**
   - Go to Railway Dashboard
   - Click "New Project"
   - Choose "Deploy from GitHub repo"
   - Select your `enbox` repository

2. **Add Services Manually**
   
   In your Railway project, you'll need to create three separate services:

   **Service 1: dwn-server**
   - Click "New Service" → "GitHub Repo"
   - Select the same repository
   - In service settings:
     - Service Name: `dwn-server`
     - Root Directory: `/` (leave empty)
     - Build Command: (leave empty - uses Dockerfile)
     - Start Command: (leave empty - uses Dockerfile)
   - In Build settings:
     - Builder: Dockerfile
     - Dockerfile Path: `packages/dwn-server/Dockerfile`

   **Service 2: web-wallet**
   - Click "New Service" → "GitHub Repo"
   - Select the same repository
   - In service settings:
     - Service Name: `web-wallet`
     - Root Directory: `/`
     - Build Command: `pnpm install && cd examples/web-wallet && pnpm build`
     - Start Command: (leave empty)
   - In Deploy settings:
     - Static Publish Path: `examples/web-wallet/dist`

   **Service 3: dapp-demo**
   - Click "New Service" → "GitHub Repo"
   - Select the same repository
   - In service settings:
     - Service Name: `dapp-demo`
     - Root Directory: `/`
     - Build Command: `pnpm install && cd examples/dapp-demo && pnpm build`
     - Start Command: (leave empty)
   - In Deploy settings:
     - Static Publish Path: `examples/dapp-demo/dist`

### Option B: Using Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project and link
railway init
railway link

# The services need to be created manually in the UI as described above
# Railway CLI doesn't support creating multiple services from a monorepo yet
```

## Step 3: Configure Environment Variables

### For dwn-server:
Follow the existing setup from RAILWAY.md:

```bash
DS_PORT = ${{PORT}}
DWN_BASE_URL = https://${{RAILWAY_PUBLIC_DOMAIN}}
DWN_TTL_CACHE_URL = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_MESSAGES = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_DATA = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_EVENTS = ${{Postgres.DATABASE_URL}}
DWN_STORAGE_RESUMABLE_TASKS = ${{Postgres.DATABASE_URL}}
DS_WEBSOCKET_SERVER = on
MAX_RECORD_DATA_SIZE = 1gb
DWN_SERVER_LOG_LEVEL = info
```

### For web-wallet and dapp-demo:
Add any required environment variables such as:
- `VITE_DWN_URL` = `https://${{dwn-server.RAILWAY_PUBLIC_DOMAIN}}`
- Any other app-specific variables

## Step 4: Set Up PostgreSQL

1. In your Railway project, click "New Service"
2. Select "Database" → "PostgreSQL"
3. Railway will automatically set up the database and provide `DATABASE_URL`

## Step 5: Connect Services

To allow web-wallet and dapp-demo to communicate with dwn-server:

1. Use Railway's internal networking by referencing service names
2. Or use the public URLs: `https://${{dwn-server.RAILWAY_PUBLIC_DOMAIN}}`

## Step 6: Deploy

Once everything is configured:

1. Railway will automatically deploy when you push to your GitHub repository
2. Each service will be built and deployed independently
3. Check the deployment logs for each service

## Deployment Structure

```
Your Railway Project
├── dwn-server (Dockerfile-based backend service)
├── web-wallet (Static React app)
├── dapp-demo (Static React app)
└── postgres (Database)
```

## Monitoring

- Each service has its own logs and metrics
- Access via Railway Dashboard → Select Service → Logs/Metrics
- Set up health checks for dwn-server at `/info`

## Troubleshooting

### Build Failures
- Check that pnpm workspace is properly configured
- Ensure all dependencies are listed in the respective package.json files
- Verify build commands work locally

### Static Site Issues
- Confirm the build output directory matches `staticPublishPath`
- Check that the build command produces files in the expected location

### Service Communication
- Use Railway's internal DNS for service-to-service communication
- Ensure environment variables are properly referencing other services

## Best Practices

1. **Use Environment Variables**: Reference other services using Railway's template variables
2. **Monitor Resources**: Each service has its own resource allocation
3. **Set Up Staging**: Create separate environments for staging and production
4. **Enable Auto-Deploy**: Set up automatic deployments from specific branches

## Cost Considerations

- Each service counts towards your Railway usage
- Static sites (web-wallet, dapp-demo) typically use minimal resources
- dwn-server and PostgreSQL will be the main resource consumers
- Consider using Railway's sleep feature for development environments