const path = require('path');

/** @type {import('esbuild').BuildOptions} */
module.exports = {
  entryPoints : ['./src/index.ts'],
  bundle      : true,
  format      : 'esm',
  sourcemap   : true,
  minify      : true,
  platform    : 'browser',
  target      : ['chrome101', 'firefox108', 'safari16'],
  define      : {
    'global'      : 'globalThis',
    'process.env' : '{}',
  },
  alias: {
    'events' : 'eventemitter3',
  },
  external: [
    'level',
  ],
};
