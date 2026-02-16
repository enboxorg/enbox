const eslint = require("@eslint/js");
const globals = require("globals");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const stylisticPlugin = require("@stylistic/eslint-plugin");
const mochaPlugin = require("eslint-plugin-mocha");

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  eslint.configs.recommended,
  mochaPlugin.configs.flat.recommended,
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { modules: true },
        ecmaVersion: "latest",
        project: true,
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
        ...globals.browser,
        console: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "@stylistic": stylisticPlugin,
      mocha: mochaPlugin,
    },
    files: ["**/*.ts"],
    // IMPORTANT and confusing: `ignores` only exclude files from the `files` setting.
    // To exclude *.js files entirely, you need to have a separate config object altogether. (See another `ignores` below.)
    ignores: ["**/*.d.ts"],
    rules: {
      "curly"      : ["error", "all"],
      "no-console" : "off",
      "no-undef"   : "off",
      "indent"     : ["error", 2, { SwitchCase: 1 }],

      "object-curly-spacing" : ["error", "always"],
      "no-multi-spaces"      : ["error"],
      "no-trailing-spaces"   : ["error"],

      "key-spacing": [
        "error",
        {
          align: {
            afterColon  : true,
            beforeColon : true,
            on          : "colon",
          },
        },
      ],

      "keyword-spacing" : ["error", { before: true, after: true }],
      "quotes"          : ["error", "single", { allowTemplateLiterals: true }],
      "max-len"         : ["error", { code: 150, ignoreStrings: true }],

      "@stylistic/semi" : ["error", "always"],
      "semi"            : ["off"],

      "no-unused-vars"                    : "off",
      "no-redeclare"                      : "off",
      "no-dupe-class-members"             : "off",
      "@typescript-eslint/no-unused-vars" : [
        "error",
        {
          vars               : "all",
          args               : "after-used",
          ignoreRestSiblings : true,
          argsIgnorePattern  : "^_",
          varsIgnorePattern  : "^_",
        },
      ],

      "@typescript-eslint/explicit-function-return-type" : ["error"],
      "@typescript-eslint/consistent-type-imports"       : "error",
      "@typescript-eslint/no-explicit-any"               : "off",
      "@typescript-eslint/no-non-null-assertion"         : "off",
      "@typescript-eslint/ban-ts-comment"                : "off",

      "prefer-const" : ["error", { destructuring: "all" }],
      "sort-imports" : ["error", {
        ignoreCase            : true,
        ignoreDeclarationSort : false,
        ignoreMemberSort      : false,
        memberSyntaxSortOrder : ["none", "all", "single", "multiple"],
        allowSeparatedGroups  : true,
      }],

      // mocha rules
      "mocha/no-exclusive-tests"   : "warn",
      "mocha/no-setup-in-describe" : "off",
      "mocha/no-mocha-arrows"      : "off",
      "mocha/max-top-level-suites" : "off",
      "mocha/no-identical-title"   : "off",
      "mocha/no-pending-tests"     : "off",
      "mocha/no-skipped-tests"     : "off",
      "mocha/no-sibling-hooks"     : "off",
    },
  },
  {
    ignores: ["**/*.js", "**/*.cjs", "**/*.mjs"],
  },
];
