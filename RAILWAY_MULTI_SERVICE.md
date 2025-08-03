# Railway Multi-Service Deployment Guide

This guide explains how to deploy dwn-server, web-wallet, and dapp-demo from this monorepo to Railway.

## Overview

Since web-wallet and dapp-demo have been moved from separate repositories into the `examples/` folder of this monorepo, we need to set up Railway to deploy all three services from a single repository.

## Step 1: Clean Up Old Deployments

If you have existing Railway services for web-wallet and dapp-demo from their old repositories:

1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Navigate to your project
3. For each old service (web-wallet and dapp-demo):
   - Click on the service
   - Go to Settings → Delete Service
   - Confirm deletion

## Step 2: Add New Services to Your Existing Project

Railway doesn't automatically detect multiple services in a monorepo. You need to manually add each one to your existing project:

### Service 1: dwn-server (Docker-based)

1. In your Railway project, click **"+ New"** → **"GitHub Repo"**
2. Select your monorepo repository
3. Configure the service:
   - **Service Name**: `dwn-server`
   - **Root Directory**: `/` (leave empty/default)
   - **Build Command**: (leave empty - uses Dockerfile)
   - **Start Command**: (leave empty - uses Dockerfile)
   - **Dockerfile Path**: `packages/dwn-server/Dockerfile`
   - **Watch Paths**: `packages/dwn-server/**,packages/common/**,packages/agent/**` (if you want auto-deploy on changes)

### Service 2: web-wallet (Static React App)

1. Click **"+ New"** → **"GitHub Repo"**
2. Select the same monorepo repository
3. Configure the service:
   - **Service Name**: `web-wallet`
   - **Root Directory**: `/` (leave empty/default)
   - **Build Command**: `cd examples/web-wallet && npm install && npm run build`
   - **Start Command**: (leave empty)
   - **Nixpacks Build Plan**: (leave default)
   - **Watch Paths**: `examples/web-wallet/**` (if you want auto-deploy on changes)
4. In the **Settings** tab after creation:
   - Set **Build Command**: `cd examples/web-wallet && npm install && npm run build`
   - Set **Static Files Path**: `examples/web-wallet/dist`

### Service 3: dapp-demo (Static React App)

1. Click **"+ New"** → **"GitHub Repo"**
2. Select the same monorepo repository
3. Configure the service:
   - **Service Name**: `dapp-demo`
   - **Root Directory**: `/` (leave empty/default)
   - **Build Command**: `cd examples/dapp-demo && npm install && npm run build`
   - **Start Command**: (leave empty)
   - **Nixpacks Build Plan**: (leave default)
   - **Watch Paths**: `examples/dapp-demo/**` (if you want auto-deploy on changes)
4. In the **Settings** tab after creation:
   - Set **Build Command**: `cd examples/dapp-demo && npm install && npm run build`
   - Set **Static Files Path**: `examples/dapp-demo/dist`

## Step 3: Configure Environment Variables

### For dwn-server:
Add the required environment variables as described in RAILWAY.md:

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
If your apps need to connect to the dwn-server, add:
- `VITE_DWN_URL` = `https://${{dwn-server.RAILWAY_PUBLIC_DOMAIN}}`
- Any other app-specific environment variables

## Step 4: Configure PostgreSQL (if not already done)

Your existing PostgreSQL database should work as-is. If you need a new one:

1. In your Railway project, click **"+ New"** → **"Database"** → **"PostgreSQL"**
2. Railway will automatically set up the database and provide `DATABASE_URL`

## Step 5: Deploy and Verify

1. Once all services are configured, they will automatically deploy
2. Each service will build independently using the configuration you provided
3. Check the deployment logs for each service to ensure successful builds

## Important Notes

### Static Site Deployment
- Railway automatically serves static files when you specify a `Static Files Path`
- No need for additional server configuration or nginx
- Railway handles all the routing and serving

### Monorepo Considerations
- All services share the same Git repository
- Changes to shared code will trigger rebuilds of affected services
- Use **Watch Paths** to control which file changes trigger deployments

### Service URLs
Each service gets its own URL:
- `dwn-server`: `https://dwn-server-<project-name>.up.railway.app`
- `web-wallet`: `https://web-wallet-<project-name>.up.railway.app`
- `dapp-demo`: `https://dapp-demo-<project-name>.up.railway.app`

## Troubleshooting

### Build Failures
- Check that the build commands work locally first
- Ensure all dependencies are properly listed in package.json files
- Verify that the build output directories match what you configured

### Path Issues
- Railway runs all commands from the repository root
- Always use `cd` to navigate to the correct directory in build commands
- Static file paths should be relative to the repository root

### Environment Variables
- Use Railway's template syntax to reference other services
- `${{service-name.RAILWAY_PUBLIC_DOMAIN}}` for inter-service communication
- `${{PORT}}` is automatically provided by Railway

## Example Build Commands

If you're using pnpm in your monorepo:
- **web-wallet**: `pnpm install && cd examples/web-wallet && pnpm build`
- **dapp-demo**: `pnpm install && cd examples/dapp-demo && pnpm build`

If the examples have their own package.json with all dependencies:
- **web-wallet**: `cd examples/web-wallet && npm install && npm run build`
- **dapp-demo**: `cd examples/dapp-demo && npm install && npm run build`

Choose the appropriate command based on your monorepo structure.