#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Check if better-sqlite3 native bindings exist
function checkNativeBindings() {
  const packages = [
    {
      name: 'dwn-server',
      version: '8.7.0',
      path: 'packages/dwn-server'
    },
    {
      name: 'dwn-sql-store', 
      version: '8.4.0',
      path: 'packages/dwn-sql-store'
    }
  ];

  let needsRebuild = false;
  
  for (const pkg of packages) {
    // Check common locations for the native binding
    const possiblePaths = [
      `node_modules/.pnpm/better-sqlite3@${pkg.version}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
      `node_modules/.pnpm/better-sqlite3@${pkg.version}/node_modules/better-sqlite3/build/better_sqlite3.node`,
      `${pkg.path}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
      `${pkg.path}/node_modules/better-sqlite3/build/better_sqlite3.node`
    ];
    
    const exists = possiblePaths.some(p => fs.existsSync(path.join(process.cwd(), p)));
    
    if (!exists) {
      console.log(`⚠️  Native bindings not found for better-sqlite3 in ${pkg.name}`);
      needsRebuild = true;
    }
  }
  
  return needsRebuild;
}

// Main execution
console.log('🔍 Checking native module bindings...');

if (checkNativeBindings()) {
  console.log('🔨 Rebuilding native modules...');
  
  try {
    // Ensure builds are allowed
    execSync('pnpm config set build.onlyBuiltDependencies \'[]\'', { stdio: 'inherit' });
    
    // Rebuild in each package
    execSync('cd packages/dwn-server && pnpm rebuild better-sqlite3', { stdio: 'inherit' });
    execSync('cd packages/dwn-sql-store && pnpm rebuild better-sqlite3', { stdio: 'inherit' });
    
    console.log('✅ Native modules rebuilt successfully!');
  } catch (error) {
    console.error('❌ Failed to rebuild native modules:', error.message);
    process.exit(1);
  }
} else {
  console.log('✅ Native bindings already exist, skipping rebuild');
}