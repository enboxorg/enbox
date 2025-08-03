#!/bin/bash

# Clean script for the monorepo

echo "🧹 Starting clean process..."

# Array of directories to clean
DIRS_TO_CLEAN=(
  # Build and dependencies
  "dist"
  "node_modules"
  "coverage"
  "generated"
  "logs"
  ".cache"
  ".parcel-cache"
  ".nyc_output"
  "tmp"
  "temp"
  "data"
  "data-test"
  # Test data
  "__TESTDATA__"
  "DATA"
  "TEST-RESUMABLE-TASK-STORE"
  "TEST-EVENTLOG"
  "TEST-DATASTORE"
  "TEST-MESSAGESTORE"
  "TEST-INDEX"
  # DWN data stores
  "DATASTORE"
  "MESSAGESTORE"
  "EVENTLOG"
  "RESOLVERCACHE"
  "RESUMABLE-TASK-STORE"
  "INDEX"
  # Benchmarks
  "BENCHMARK-INDEX"
  "BENCHMARK-BLOCK"
)

# Use npkill for the most common directories
echo "🗑️  Removing build artifacts and dependencies..."
pnpm npkill -d $(pwd) -t dist -D -y
pnpm npkill -d $(pwd) -t node_modules -D -y

# Remove all other directories in a single find command
echo "🗑️  Removing test data, caches, and other directories..."
for dir in "${DIRS_TO_CLEAN[@]:2}"; do
  find . -type d -name "$dir" -prune -exec rm -rf {} \; 2>/dev/null
done

# Remove database files (recursively in all packages)
echo "Removing database files..."
find . -name "*.sqlite" -type f -delete 2>/dev/null || true
find . -name "*.db" -type f -delete 2>/dev/null || true

# Remove bundle metadata files
echo "Removing bundle metadata files..."
find . -name "bundle-metadata.json" -type f -delete 2>/dev/null || true

# Remove TypeScript build info files
echo "Removing TypeScript build info files..."
find . -name "*.tsbuildinfo" -type f -delete

echo "✅ Clean complete!"