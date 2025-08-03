# Railway Setup for Enbox Monorepo

This guide shows how to deploy dwn-server, web-wallet, and dapp-demo from this monorepo to Railway.

## Prerequisites

- Railway account
- This repository connected to Railway

## Setup Instructions

### 1. Create Services in Railway

In your Railway project, you'll need to create three services:

#### Service 1: DWN Server (Docker)
1. Click **"+ New"** → **"GitHub Repo"**
2. Select this repository
3. Configure:
   - **Service Name**: `dwn-server`
   - **Root Directory**: `/` (leave empty)
   - **Build Command**: (leave empty - uses Dockerfile)
   - **Dockerfile Path**: `packages/dwn-server/Dockerfile`

#### Service 2: Web Wallet (Static Site)
1. Click **"+ New"** → **"GitHub Repo"**  
2. Select this repository
3. Configure:
   - **Service Name**: `web-wallet`
   - **Root Directory**: `/` (leave empty)
   - **Build Command**: `cd examples/web-wallet && npm install && npm run build`
   - **Start Command**: (leave empty)
   - **Static Files Path**: `examples/web-wallet/dist`

#### Service 3: Demo App (Static Site)
1. Click **"+ New"** → **"GitHub Repo"**
2. Select this repository  
3. Configure:
   - **Service Name**: `dapp-demo`
   - **Root Directory**: `/` (leave empty)
   - **Build Command**: `cd examples/dapp-demo && npm install && npm run build`
   - **Start Command**: (leave empty)
   - **Static Files Path**: `examples/dapp-demo/dist`

### 2. Add PostgreSQL for DWN Server

1. Click **"+ New"** → **"Database"** → **"PostgreSQL"**
2. Railway will automatically set up the database connection

### 3. Configure Environment Variables

For the dwn-server service, add these environment variables:
```
DS_PORT=${{PORT}}
DWN_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
DWN_TTL_CACHE_URL=${{Postgres.DATABASE_URL}}
DWN_STORAGE_MESSAGES=${{Postgres.DATABASE_URL}}
DWN_STORAGE_DATA=${{Postgres.DATABASE_URL}}
DWN_STORAGE_EVENTS=${{Postgres.DATABASE_URL}}
DWN_STORAGE_RESUMABLE_TASKS=${{Postgres.DATABASE_URL}}
```

### 4. Deploy

Once configured, Railway will automatically deploy all services when you push to the repository.

## Benefits of This Approach

- ✅ **Simple**: Just UI configuration, no complex config files
- ✅ **Maintainable**: All code in one repository
- ✅ **Scalable**: Each service can be scaled independently
- ✅ **Cost-effective**: Static sites are cheap to host
- ✅ **Version control**: All changes tracked in one place

## Alternative: Create Separate Repositories

If you really prefer separate deployments, you could:

1. Extract `examples/web-wallet` to `github.com/enboxorg/web-wallet`
2. Extract `examples/dapp-demo` to `github.com/enboxorg/dapp-demo`
3. Add them back as git submodules

But this adds complexity without much benefit since Railway handles monorepos well.