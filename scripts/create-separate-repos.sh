#!/bin/bash

# Script to extract web-wallet and dapp-demo into separate repositories
# This maintains git history for the extracted folders

echo "This script will help you create separate repositories for web-wallet and dapp-demo"
echo "You'll need to create the repositories on GitHub first:"
echo "  - https://github.com/enboxorg/web-wallet"
echo "  - https://github.com/enboxorg/dapp-demo"
echo ""
read -p "Have you created these repositories? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Please create the repositories first, then run this script again."
    exit 1
fi

# Extract web-wallet
echo "Extracting web-wallet..."
git subtree split --prefix=examples/web-wallet -b web-wallet-branch
mkdir -p /tmp/web-wallet
cd /tmp/web-wallet
git init
git pull ../../ web-wallet-branch
git remote add origin https://github.com/enboxorg/web-wallet.git

# Add Railway configuration
cat > railway.json << 'EOF'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "numReplicas": 1,
    "sleepApplication": false,
    "restartPolicyType": "ON_FAILURE",
    "staticPublishPath": "dist"
  }
}
EOF

git add railway.json
git commit -m "Add Railway configuration"
git push -u origin main

# Extract dapp-demo
cd -
echo "Extracting dapp-demo..."
git subtree split --prefix=examples/dapp-demo -b dapp-demo-branch
mkdir -p /tmp/dapp-demo
cd /tmp/dapp-demo
git init
git pull ../../ dapp-demo-branch
git remote add origin https://github.com/enboxorg/dapp-demo.git

# Add Railway configuration
cat > railway.json << 'EOF'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm install && npm run build"
  },
  "deploy": {
    "numReplicas": 1,
    "sleepApplication": false,
    "restartPolicyType": "ON_FAILURE",
    "staticPublishPath": "dist"
  }
}
EOF

git add railway.json
git commit -m "Add Railway configuration"
git push -u origin main

cd -
echo "Done! Now you can remove the examples folders and add them as submodules."