/**
 * Shared browser bundle builder for all packages.
 *
 * Produces a single ESM bundle at dist/browser.mjs.
 * Invoke from a package directory:
 *   bun ../../build/browser-bundle.js [--node-shims] [--extra-entry src/utils.ts:dist/utils.js] [--metafile]
 *
 * Options:
 *   --node-shims     Enable process.env stub, events->eventemitter3 alias, level externalization
 *   --extra-entry    Additional entry:output pairs (can be repeated)
 *   --metafile       Write bundle-metadata.json with esbuild metafile output
 */
import fs from 'node:fs';
import esbuild from 'esbuild';
import { browserConfig } from './esbuild-browser-config.cjs';

const args = process.argv.slice(2);
const nodeShims = args.includes('--node-shims');
const metafile = args.includes('--metafile');

// Parse --extra-entry flags: --extra-entry src/utils.ts:dist/utils.js
const extraEntries = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extra-entry' && args[i + 1]) {
    const [entry, output] = args[i + 1].split(':');
    extraEntries.push({ entry, output });
    i++;
  }
}

const config = browserConfig({ nodeShims });

// Primary ESM bundle
const primaryBuild = esbuild.build({
  ...config,
  metafile,
  outfile : 'dist/browser.mjs',
}).then((result) => {
  if (metafile && result.metafile) {
    fs.writeFileSync('bundle-metadata.json', JSON.stringify(result.metafile, null, 4), 'utf8');
  }
});

// Extra entry bundles (e.g. utils.ts for crypto and dids)
const extraBuilds = extraEntries.map(({ entry, output }) =>
  esbuild.build({
    ...config,
    entryPoints : [entry],
    outfile     : output,
  }),
);

await Promise.all([primaryBuild, ...extraBuilds]);
