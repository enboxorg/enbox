import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, cpSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWatch = process.argv.includes('--watch');

// Ensure dist directories exist
const localDistDir = join(__dirname, 'dist');
const serverDistDir = join(__dirname, '..', '..', '..', 'dist', 'esm', 'src', 'admin-ui', 'dist');

mkdirSync(localDistDir, { recursive: true });
mkdirSync(serverDistDir, { recursive: true });

// Copy HTML file
copyFileSync(
  join(__dirname, 'public', 'index.html'),
  join(localDistDir, 'index.html')
);

// Build options
const buildOptions = {
  entryPoints: [join(__dirname, 'src', 'App.tsx')],
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch,
  target: 'es2020',
  outfile: join(__dirname, 'dist', 'app.js'),
  format: 'esm',
  loader: {
    '.tsx': 'tsx',
    '.ts': 'ts',
  },
  jsx: 'automatic',
};

async function build() {
  if (isWatch) {
    // Watch mode
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log('Watching for changes...');
  } else {
    // Build once
    try {
      await esbuild.build(buildOptions);
      
      // Copy built files to server dist directory
      cpSync(localDistDir, serverDistDir, { recursive: true });
      
      console.log('Build completed successfully');
    } catch (error) {
      console.error('Build failed:', error);
      process.exit(1);
    }
  }
}

build();