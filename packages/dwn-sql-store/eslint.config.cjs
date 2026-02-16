const baseConfig = require('../../eslint.config.cjs');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  ...baseConfig,
  {
    rules: {
      '@typescript-eslint/no-floating-promises' : ['error'],
    },
  },
  {
    ignores: [
      'dist/**',
      'tests/compiled/**',
    ],
  },
];
