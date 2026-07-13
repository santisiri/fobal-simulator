import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // several suites run full 90-minute matches; parallel forks starve the
    // WebSocket integration tests' event loops and flake their timeouts
    fileParallelism: false,
  },
});
