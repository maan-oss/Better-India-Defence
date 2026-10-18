import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
  },
});
