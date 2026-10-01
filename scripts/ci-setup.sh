#!/bin/bash
set -e

echo "Setting up CI environment..."

# Clean everything first
echo "Cleaning workspace..."
bun run clean || true

# Install dependencies
echo "Installing dependencies..."
./scripts/ci-install.sh

# Build all packages
echo "Building packages..."
bun run build

echo "CI setup complete!"
