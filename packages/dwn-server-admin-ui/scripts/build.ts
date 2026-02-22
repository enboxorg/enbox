import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Bundle the Preact SPA into a single JS + CSS bundle.
await build({
  entryPoints : [join(root, 'src/index.tsx')],
  bundle      : true,
  minify      : true,
  sourcemap   : true,
  outdir      : join(root, 'dist'),
  format      : 'esm',
  target      : ['es2020'],
  jsx         : 'automatic',
  jsxImportSource : 'preact',
  entryNames  : 'app',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: {
    '.tsx': 'tsx',
    '.ts' : 'ts',
    '.css': 'css',
  },
});

// Copy public/ assets (index.html etc.) into dist/.
mkdirSync(join(root, 'dist'), { recursive: true });
cpSync(join(root, 'public'), join(root, 'dist'), { recursive: true });

// Write a Node module that exports the dist path for dwn-server to locate the assets.
const indexJs = `
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
export const adminUiDistPath = __dirname;
`;

await Bun.write(join(root, 'dist/index.js'), indexJs.trim() + '\n');

console.log('Admin UI built successfully.');
