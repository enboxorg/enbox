#!/bin/bash

# Script to add web-wallet and dapp-demo as git submodules

echo "Adding web-wallet and dapp-demo as git submodules..."

# Remove existing directories if they exist
if [ -d "examples/web-wallet" ]; then
    echo "Removing existing examples/web-wallet directory..."
    rm -rf examples/web-wallet
fi

if [ -d "examples/dapp-demo" ]; then
    echo "Removing existing examples/dapp-demo directory..."
    rm -rf examples/dapp-demo
fi

# Add web-wallet submodule
echo "Adding web-wallet submodule..."
git submodule add https://github.com/enboxorg/web-wallet.git examples/web-wallet

# Add dapp-demo submodule
echo "Adding dapp-demo submodule..."
git submodule add https://github.com/enboxorg/dapp-demo.git examples/dapp-demo

# Initialize and update submodules
echo "Initializing submodules..."
git submodule update --init --recursive

echo "Done! Submodules have been added."
echo ""
echo "To commit these changes:"
echo "  git add .gitmodules examples/web-wallet examples/dapp-demo"
echo "  git commit -m 'Add web-wallet and dapp-demo as git submodules'"