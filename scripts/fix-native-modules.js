#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🔧 Fixing native module builds...');

// List of packages that have native dependencies
const packagesWithNativeModules = [
  { path: 'packages/dwn-server', modules: ['better-sqlite3'] },
  { path: 'packages/dwn-sql-store', modules: ['better-sqlite3'] }
];

packagesWithNativeModules.forEach(({ path: pkgPath, modules }) => {
  const fullPath = path.join(process.cwd(), pkgPath);
  
  if (fs.existsSync(fullPath)) {
    console.log(`📦 Rebuilding native modules in ${pkgPath}...`);
    
    modules.forEach(module => {
      try {
        execSync(`cd ${fullPath} && pnpm rebuild ${module}`, { 
          stdio: 'inherit',
          shell: true 
        });
        console.log(`   ✅ ${module} rebuilt successfully`);
      } catch (error) {
        console.warn(`   ⚠️  Failed to rebuild ${module} in ${pkgPath}:`, error.message);
      }
    });
  }
});

console.log('✨ Native module fixes complete!');