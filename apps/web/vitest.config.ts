import { defineConfig } from 'vitest/config';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
      '@': join(__dirname, 'src'),
    },
  },
});
