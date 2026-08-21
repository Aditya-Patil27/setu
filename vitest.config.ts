import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to source, so suites run without a build step.
  // Their package.json "main" points at dist/, which need not exist to test.
  resolve: {
    alias: {
      '@setu/shared': src('shared'),
      '@setu/db': src('db'),
    },
  },
  test: {
    include: [
      'tests/**/*.test.ts',
      'services/**/__tests__/**/*.test.ts',
      'packages/**/__tests__/**/*.test.ts',
    ],
    // Every suite talks to a real Postgres; the defaults are too tight for
    // container startup and per-file schema provisioning.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['tests/global-setup.ts'],
    // Forks keep each file's pg pools genuinely isolated.
    pool: 'forks',
  },
});
