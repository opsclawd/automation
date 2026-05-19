/**
 * Layer rules for the AI-SDLC orchestrator monorepo.
 *
 * Layering (inner -> outer):
 *   shared        — pure utilities, no workspace deps
 *   domain        — business types/functions, may depend on shared
 *   application   — use cases, may depend on domain + shared (NOT infrastructure)
 *   infrastructure— adapters (sqlite, fs, bash), may depend on domain + shared
 *   apps/api      — composition root + CLI/HTTP, may depend on all packages
 *   apps/web      — UI, may depend on shared/domain only
 *
 * The single legal cross-layer composition point is apps/api/src/compose.ts.
 *
 * Run: pnpm depcruise
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are forbidden.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'application-cannot-depend-on-infrastructure',
      severity: 'error',
      comment:
        'packages/application MUST NOT import @ai-sdlc/infrastructure. ' +
        'Define a port in packages/application/src/ports.ts and wire ' +
        'the infra adapter from apps/api/src/compose.ts instead.',
      from: { path: '^packages/application/src' },
      to: { path: '^packages/infrastructure' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'packages/domain may only depend on packages/shared.',
      from: { path: '^packages/domain/src' },
      to: {
        path: '^packages/(application|infrastructure)',
      },
    },
    {
      name: 'shared-has-no-workspace-deps',
      severity: 'error',
      comment: 'packages/shared must not depend on any other workspace package.',
      from: { path: '^packages/shared/src' },
      to: { path: '^packages/(domain|application|infrastructure)' },
    },
    {
      name: 'infrastructure-cannot-depend-on-application',
      severity: 'error',
      comment: 'Infrastructure adapters must not depend on application use cases.',
      from: { path: '^packages/infrastructure/src' },
      to: { path: '^packages/application' },
    },
    {
      name: 'web-stays-out-of-server-layers',
      severity: 'error',
      comment: 'apps/web is a browser bundle; it must not import api/application/infrastructure.',
      from: { path: '^apps/web/src' },
      to: { path: '^(apps/api|packages/(application|infrastructure))' },
    },
    {
      name: 'compose-is-only-cross-layer-importer',
      severity: 'error',
      comment:
        'Only apps/api/src/compose.ts may import both @ai-sdlc/application and ' +
        '@ai-sdlc/infrastructure. Move wiring there.',
      from: {
        path: '^apps/api/src',
        pathNot: ['^apps/api/src/compose\\.ts$', '(^|/)__tests__/'],
      },
      to: {
        path: '^packages/infrastructure',
        // Allow re-exports/types consumed indirectly via application; this
        // rule targets direct adapter wiring, not type imports of repos
        // that are constructed in compose.ts.
      },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'Orphan modules (no incoming deps and not an entry point) likely indicate dead code.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$', // dotfiles like .eslintrc
          '\\.config\\.(js|cjs|mjs|ts)$',
          '(^|/)__tests__/',
          '(^|/)dist/',
        ],
      },
      to: {},
    },
    {
      name: 'no-test-imports-from-non-test',
      severity: 'error',
      comment: 'Production code must not import test files.',
      from: { pathNot: '__tests__' },
      to: { path: '__tests__' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|coverage|\\.ai-runs|\\.ai-worktrees)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['development', 'import', 'require', 'node', 'default'],
      mainFields: ['main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
