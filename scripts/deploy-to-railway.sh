#!/bin/bash

# Deploy script for Railway monorepo
# This automates the service creation process

echo "🚂 Deploying Enbox monorepo to Railway..."

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Please install it first:"
    echo "npm install -g @railway/cli"
    exit 1
fi

# Login to Railway
echo "📝 Logging into Railway..."
railway login

# Create or link project
echo "🏗️ Setting up Railway project..."
railway link

# Deploy dwn-server
echo "🚀 Deploying dwn-server..."
railway up --service dwn-server \
  --dockerfile packages/dwn-server/Dockerfile

# Deploy web-wallet
echo "🚀 Deploying web-wallet..."
railway up --service web-wallet \
  --build "cd examples/web-wallet && npm install && npm run build" \
  --static examples/web-wallet/dist

# Deploy dapp-demo
echo "🚀 Deploying dapp-demo..."
railway up --service dapp-demo \
  --build "cd examples/dapp-demo && npm install && npm run build" \
  --static examples/dapp-demo/dist

echo "✅ Deployment complete!"
echo "Visit your Railway dashboard to configure environment variables"