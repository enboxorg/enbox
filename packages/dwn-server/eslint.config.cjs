const baseConfig = require('../../eslint.config.cjs');
const todoPlzPlugin = require('eslint-plugin-todo-plz');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  ...baseConfig,
  {
    plugins: {
      'todo-plz': todoPlzPlugin,
    },
    rules: {
      'brace-style' : ['error', '1tbs', { allowSingleLine: false }],
      // enforce github issue reference for every TO-DO comment
      'todo-plz/ticket-ref': [
        'error',
        { commentPattern: '.*github.com/enboxorg/enbox/issues/.*' },
      ],
    },
  },
  {
    ignores: [
      'types.d.ts',
      'dist/**',
      'node_modules/**',
      'tests/compiled/**',
      'tests/fixtures/**',
      'tests/**/*.js',
      'tests/cors.spec.ts',
    ],
  },
];
