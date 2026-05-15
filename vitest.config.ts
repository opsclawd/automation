import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/__tests__/**/*.test.ts', 'apps/**/__tests__/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    },
  },
});