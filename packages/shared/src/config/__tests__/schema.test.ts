import { describe, it, expect } from 'vitest';
import { orchestratorConfigSchema } from '../schema.js';

describe('phases.reviewFix.architectPass', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults architectPass to enabled=false when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.phases.reviewFix.architectPass).toEqual({ enabled: false, timeoutMinutes: 10 });
  });

  it('accepts architectPass.enabled=true with custom timeoutMinutes', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        reviewFix: {
          maxIterations: 5,
          architectPass: { enabled: true, timeoutMinutes: 20 },
        },
      },
    });
    expect(parsed.phases.reviewFix.architectPass).toEqual({
      enabled: true,
      timeoutMinutes: 20,
    });
  });

  it('rejects negative timeoutMinutes', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        reviewFix: {
          maxIterations: 5,
          architectPass: { enabled: true, timeoutMinutes: -1 },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
