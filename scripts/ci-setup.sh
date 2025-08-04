#!/bin/bash
set -e

echo "🔧 Setting up CI environment..."

# Clean everything first
echo "🧹 Cleaning workspace..."
pnpm clean || true

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

# Rebuild native modules explicitly
echo "🔨 Rebuilding native modules..."
pnpm rebuild:native

# Additional rebuild for safety (sometimes needed in CI)
echo "🔨 Running additional native module rebuild..."
pnpm rebuild better-sqlite3 --recursive || true

# Build all packages
echo "🏗️  Building packages..."
pnpm build

echo "✅ CI setup complete!"