import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    passWithNoTests: true,
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
