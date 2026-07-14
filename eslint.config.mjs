import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/web/next-env.d.ts',
      // Operational scratch/state directories (see .gitignore). These are
      // gitignored but not excluded from eslint's own file scan by default —
      // a stale fixture in ai/ (merge-conflict-marker test data) broke
      // `pnpm lint` with a parse error despite never being tracked by git.
      'ai/**',
      '.ai-runs/**',
      '.ai-tmp/**',
      '.ai-worktrees/**',
      '.claude/**',
      '.context/**',
      '.review-context/**',
      '.antigravitycli/**',
      'cache/**',
      'test-results/**',
      'changes/**',
      'review-reports/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
];
