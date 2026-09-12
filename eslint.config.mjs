// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, dependencies and harness state are not ours to lint.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '.claude-flow/**',
      '.swarm/**',
      '.storage/**',
    ],
  },

  // Plain JS: the migration and seed runners in scripts/.
  {
    files: ['**/*.mjs', '**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // The Node globals the scripts in this repo actually use. Listed rather
      // than pulled from the `globals` package to keep the dev dependencies
      // small; a new undefined global is a lint error, which is the point.
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },

  // TypeScript sources. Non-type-checked: the type errors are tsc's job, and
  // `npm run typecheck` already runs it over the same files in CI.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),

  {
    files: ['**/*.ts'],
    rules: {
      // An unused parameter is often a deliberate signature match; an unused
      // local is not. Underscore opts out explicitly.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
