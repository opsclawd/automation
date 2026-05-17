import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only discovers tests inside __tests__/ directories — enforces convention.
    // If a .test.ts file outside __tests__/ is added, it will silently be skipped.
    include: ['src/**/__tests__/**/*.test.ts'],
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
