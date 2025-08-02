module.exports = {
  root           : true,
  ignorePatterns : ['dist','tests/compiled'],
  extends        : ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parser         : '@typescript-eslint/parser',
  parserOptions  : {
    ecmaVersion : 2022,
    sourceType  : 'module',
    project: ['tsconfig.json', 'tests/tsconfig.json'] ,
  },
  plugins : ['@typescript-eslint'],
  env     : {
    node   : true,
    es2022 : true
  },
  rules: {
    'key-spacing': [
      'error',
      {
        'align': {
          'afterColon'  : true,
          'beforeColon' : true,
          'on'          : 'colon'
        }
      }
    ],
    'quotes': [
      'error',
      'single',
      { 'allowTemplateLiterals': true }
    ],
    'indent'                            : ['error', 2],
    'no-unused-vars'                    : 'off',
    'no-trailing-spaces'                 : ['error'],
    'prefer-const'                      : 'off',
    'semi'                              : ['error', 'always'],
    '@typescript-eslint/no-unused-vars' : [
      'error',
      {
        'vars'               : 'all',
        'args'               : 'after-used',
        'ignoreRestSiblings' : true,
        'argsIgnorePattern'  : '^_',
        'varsIgnorePattern'  : '^_'
      }
    ],
    '@typescript-eslint/no-explicit-any' : 'off',
    '@typescript-eslint/no-floating-promises': ['error'],
  }
};