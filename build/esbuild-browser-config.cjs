/**
 * Shared esbuild browser bundle configuration for all packages.
 *
 * Usage (from a package's build script):
 *   const { browserConfig } = require('../../build/esbuild-browser-config.cjs');
 *   const config = browserConfig({ nodeShims: true });
 *
 * @param {object} [options]
 * @param {boolean} [options.nodeShims]  Add process.env stub, events alias, and
 *                                       level externalization (agent, api, dwn-sdk-js).
 * @param {string}  [options.entryPoint] Override the default './src/index.ts' entry.
 * @returns {import('esbuild').BuildOptions}
 */
function browserConfig(options = {}) {
  const { nodeShims = false, entryPoint = './src/index.ts' } = options;

  /** @type {import('esbuild').BuildOptions} */
  const config = {
    entryPoints : [entryPoint],
    bundle      : true,
    format      : 'esm',
    sourcemap   : true,
    minify      : true,
    platform    : 'browser',
    target      : ['chrome101', 'firefox108', 'safari16'],
    define      : {
      'global': 'globalThis',
    },
  };

  if (nodeShims) {
    config.define['process.env'] = '{}';
    config.alias = { 'events': 'eventemitter3' };
    config.external = ['level'];
  }

  return config;
}

module.exports = { browserConfig };
