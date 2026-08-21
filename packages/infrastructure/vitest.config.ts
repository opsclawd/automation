import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Cap forked workers: infrastructure's validation-adapter.test.ts and
    // validation-cache-policy.test.ts spawn real `pnpm build`/`pnpm test` in
    // fixtures. With pnpm -r --parallel test the package already runs alongside
    // six other vitest workers; default fork count thrashes the host and 5s
    // vitest test timeouts trip on the inner pnpm runs. Run serially within
    // this package to keep wall time predictable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
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
