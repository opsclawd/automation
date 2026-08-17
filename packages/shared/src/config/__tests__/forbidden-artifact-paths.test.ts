import { describe, it, expect } from 'vitest';
import { orchestratorConfigSchema } from '../schema.js';

describe('validation.forbiddenArtifactPaths schema', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('leaves forbidden artifact checking disabled when the config key is absent', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect((parsed.validation as Record<string, unknown>).forbiddenArtifactPaths).toBeUndefined();
  });

  it('accepts repository-relative forbidden artifact path prefixes', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        forbiddenArtifactPaths: ['certification/'],
      } as Record<string, unknown>,
    });
    expect((parsed.validation as Record<string, unknown>).forbiddenArtifactPaths).toEqual([
      'certification/',
    ]);
  });
});
