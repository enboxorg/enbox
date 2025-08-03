import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes('--watch');

// Ensure dist directory exists
const distDir = join(__dirname, 'dist');
mkdirSync(distDir, { recursive: true });

// Copy HTML file
copyFileSync(
  join(__dirname, 'public', 'index.html'),
  join(distDir, 'index.html')
);

// Build options for the React app
const buildOptions = {
  entryPoints: [join(__dirname, 'src', 'App.tsx')],
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch,
  target: 'es2020',
  outfile: join(distDir, 'app.js'),
  format: 'esm',
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
  },
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"'
  }
};

async function build() {
  if (isWatch) {
    // Watch mode
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log('Watching for changes...');
    console.log('Admin UI available at http://localhost:5173');
  } else {
    // Build once
    try {
      await esbuild.build(buildOptions);
      console.log('Build completed successfully');
    } catch (error) {
      console.error('Build failed:', error);
      process.exit(1);
    }
  }
}

build();