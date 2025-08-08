#!/bin/bash
set -e

echo "🔧 Setting up CI environment..."

# Clean everything first
echo "🧹 Cleaning workspace..."
pnpm clean || true

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

# No native modules to rebuild
echo "🔨 Skipping native module rebuilds..."

# Build all packages
echo "🏗️  Building packages..."
pnpm build

echo "✅ CI setup complete!"