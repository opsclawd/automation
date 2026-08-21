import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    passWithNoTests: true,
    // Cap forked workers: apps/cli integration tests spin up composeRoot with
    // SQLite + subprocesses. With pnpm -r --parallel test, the package already
    // runs alongside six other vitest workers; default fork count (CPU cores)
    // thrashes the host and 5s/20s integration test timeouts trip. Run serially
    // within this package to keep wall time predictable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
});
