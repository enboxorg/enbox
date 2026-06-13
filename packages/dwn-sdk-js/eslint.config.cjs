const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const stylisticPlugin = require("@stylistic/eslint-plugin");
const todoPlzPlugin = require('eslint-plugin-todo-plz');

module.exports = [{
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { modules: true },
      ecmaVersion: 'latest',
      project: ['./tsconfig.json', './tests/tsconfig.json'],
    },
  },
  plugins: {
    "@typescript-eslint": tsPlugin,
    "@stylistic": stylisticPlugin,
    'todo-plz': todoPlzPlugin // for enforcing TODO formatting to require "github.com/enboxorg/enbox/issues/"
  },
  files: [
    '**/*.ts'
  ],
  // IMPORTANT and confusing: `ignores` only exclude files from the `files` setting.
  // To exclude *.js files entirely, you need to have a separate config object altogether. (See another `ignores` below.)
  ignores: [
    '**/*.d.ts',
    '**/vitest.browser.config.ts',
  ],
  rules: {
    'curly'      : ['error', 'all'],
    'no-console' : 'off',
    'indent'     : [
      'error',
      2
    ],
    'object-curly-spacing' : ['error', 'always'],
    'linebreak-style'      : [
      'error',
      'unix'
    ],
    'quotes': [
      'error',
      'single',
      { 'allowTemplateLiterals': true }
    ],
    '@stylistic/semi' : ['error', 'always'],
    'semi'            : ['off'],
    'no-multi-spaces'         : ['error'],
    'no-trailing-spaces'      : ['error'],
    'max-len'                 : ['error', { 'code': 150, 'ignoreStrings': true }],
    'key-spacing'             : [
      'error',
      {
        'align': {
          'beforeColon' : true,
          'afterColon'  : true,
          'on'          : 'colon'
        }
      }
    ],
    'keyword-spacing'                                  : ['error', { 'before': true, 'after': true }],
    '@typescript-eslint/explicit-function-return-type' : ['error'],
    'no-unused-vars'                                   : 'off',
    // enforce `import type` when an import is not used at runtime, allowing transpilers/bundlers to drop imports as an optimization
    '@typescript-eslint/consistent-type-imports'       : 'error',
    '@typescript-eslint/no-unused-vars'                : [
      'error',
      {
        'vars'               : 'all',
        'args'               : 'after-used',
        'ignoreRestSiblings' : true,
        'argsIgnorePattern'  : '^_',
        'varsIgnorePattern'  : '^_'
      }
    ],

    'prefer-const' : ['error', { 'destructuring': 'all' }],
    'sort-imports' : ['error', {
      'ignoreCase'            : true,
      'ignoreDeclarationSort' : false,
      'ignoreMemberSort'      : false,
      'memberSyntaxSortOrder' : ['none', 'all', 'single', 'multiple'],
      'allowSeparatedGroups'  : true
    }],
    // enforce github issue reference for every TO-DO comment
    'todo-plz/ticket-ref': ['error', { 'commentPattern': '.*github\.com\/enboxorg\/enbox\/issues\/.*' }],
  }
}, {
  // Replay-basis closure boundary:
  // validation modules read state only through `ValidationStateReader` (HandlerDependencies.validationStateReader).
  // Importing `MessageStore` here would open a validation read outside the reader surface.
  files: [
    'src/core/*grant-authorization*.ts',
    'src/core/protocol-authorization*.ts',
    'src/protocols/permissions*.ts',
  ],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group   : ['**/types/message-store.js'],
        message : 'Validation modules must read state through ValidationStateReader, never MessageStore directly. ' +
                  'A new state read needs a ValidationStateReader method first.',
      }],
    }],
  },
}, {
  ignores: [
    '**/*.js',
  ],
}];
