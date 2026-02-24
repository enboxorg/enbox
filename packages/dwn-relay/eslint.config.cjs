const path = require('path');
const baseConfig = require('../../eslint.config.cjs');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        project         : path.join(__dirname, 'tsconfig.eslint.json'),
        tsconfigRootDir : __dirname,
      },
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
    ],
  },
];
