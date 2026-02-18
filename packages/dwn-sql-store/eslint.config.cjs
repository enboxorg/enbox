const baseConfig = require('../../eslint.config.cjs');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tests/tsconfig.json'],
      },
    },
  },
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
