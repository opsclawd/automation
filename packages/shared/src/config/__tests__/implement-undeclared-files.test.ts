import { describe, it, expect } from 'vitest';
import { orchestratorConfigSchema } from '../schema.js';

describe('phases.implement.exemptUndeclaredFiles', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults undeclared-file exemptions to an empty list', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.phases.implement.exemptUndeclaredFiles).toEqual([]);
  });

  it('preserves explicitly configured exact repository paths', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        implement: {
          ...baseConfig.phases.implement,
          exemptUndeclaredFiles: ['pnpm-lock.yaml', 'generated/client.ts'],
        },
      },
    });
    expect(parsed.phases.implement.exemptUndeclaredFiles).toEqual([
      'pnpm-lock.yaml',
      'generated/client.ts',
    ]);
  });

  it('rejects non-string exemption entries', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        implement: {
          ...baseConfig.phases.implement,
          exemptUndeclaredFiles: ['pnpm-lock.yaml', 42],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
