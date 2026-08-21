import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    // Cap forked workers: 8 uncapped forks peak at ~800MB each and have
    // OOM-killed 16GB hosts when validation overlaps an agent test run.
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
  resolve: {
    conditions: ['development'],
  },
  ssr: {
    resolve: {
      conditions: ['development'],
    },
  },
});
