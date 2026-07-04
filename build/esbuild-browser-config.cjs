/**
 * Shared esbuild browser bundle configuration for all packages.
 *
 * Usage (from a package's build script):
 *   const { browserConfig } = require('../../build/esbuild-browser-config.cjs');
 *   const config = browserConfig();
 *
 * @param {object} [options]
 * @param {string}  [options.entryPoint] Override the default './src/index.ts' entry.
 * @param {Record<string, string>} [options.aliases] Additional esbuild aliases.
 * @param {string[]} [options.externals] Exact module specifiers to leave external.
 * @returns {import('esbuild').BuildOptions}
 */
function browserConfig(options = {}) {
  const { entryPoint = './src/index.ts', aliases = {}, externals = [] } = options;
  const aliasEntries = Object.entries(aliases);
  const externalEntries = [...externals];
  const plugins = [];

  if (aliasEntries.length > 0) {
    plugins.push(exactAliasPlugin(aliasEntries));
  }

  if (externalEntries.length > 0) {
    plugins.push(exactExternalPlugin(externalEntries));
  }

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
    // abstract-level (used by level/browser-level) requires the Node 'events'
    // built-in. Alias it to eventemitter3 so the bundle works in browsers.
    alias: {
      'events': 'eventemitter3',
    },
    plugins: plugins.length > 0 ? plugins : undefined,
  };

  return config;
}

function exactAliasPlugin(aliasEntries) {
  const path = require('node:path');

  return {
    name: 'exact-alias',
    setup(build) {
      for (const [specifier, replacement] of aliasEntries) {
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(specifier)}$`) }, () => ({
          path: replacement.startsWith('.') ? path.resolve(process.cwd(), replacement) : replacement,
        }));
      }
    },
  };
}

function exactExternalPlugin(specifiers) {
  return {
    name: 'exact-external',
    setup(build) {
      for (const specifier of specifiers) {
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(specifier)}$`) }, () => ({
          path     : specifier,
          external : true,
        }));
      }
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { browserConfig };
