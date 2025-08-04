#!/usr/bin/env bun
import { $ } from "bun";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

console.log("🚀 Migrating to simplified Bun build system...\n");

// Step 1: Clean up old build artifacts
console.log("📦 Cleaning up old build artifacts...");
await $`find . -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true`;
await $`find . -name "tsconfig.cjs.json" -type f -delete`;
await $`find . -path "*/build/cjs-bundle.js" -delete`;
await $`find . -path "*/build/create-cjs-bundle.cjs" -delete`;
await $`find . -path "*/build/bundles.js" -delete`;
await $`find . -path "*/build/esbuild-*.cjs" -delete`;

// Step 2: List packages that need updating
const packages = await readdir("packages");
console.log(`\n📋 Found ${packages.length} packages to update:`);
packages.forEach(pkg => console.log(`   - ${pkg}`));

// Step 3: Install bun types
console.log("\n📥 Installing bun-types...");
await $`bun add -d bun-types`;

// Step 4: Show next steps
console.log("\n✅ Initial cleanup complete!");
console.log("\n📝 Next steps for each package:");
console.log("1. Update package.json:");
console.log("   - Remove 'main' pointing to dist/cjs");
console.log("   - Remove 'require' from exports");
console.log("   - Simplify build scripts");
console.log("\n2. For packages using better-sqlite3:");
console.log("   - Replace with 'bun:sqlite'");
console.log("   - Update imports: import { Database } from 'bun:sqlite'");
console.log("\n3. Update test scripts:");
console.log("   - Replace 'mocha' with 'bun test'");
console.log("   - Remove test compilation steps");
console.log("\n4. For browser packages:");
console.log("   - Use: bun build ./src/index.ts --target browser --format esm");

// Step 5: Create example package.json
console.log("\n📄 Example simplified package.json:");
console.log(`
{
  "name": "@enbox/example",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "build:browser": "bun build ./src/index.ts --outdir dist --format esm --target browser",
    "test": "bun test",
    "clean": "rm -rf dist"
  }
}
`);

console.log("\n🎉 Migration preparation complete!");
console.log("Run 'bun install' to install dependencies with Bun.\n");