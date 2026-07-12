import { describe, it, expect } from 'vitest';
import { orchestratorConfigSchema } from '../schema.js';

describe('phases.implement.deltaScopedReReview', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults deltaScopedReReview to true when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.phases.implement.deltaScopedReReview).toBe(true);
  });

  it('accepts deltaScopedReReview=false to disable intermediate delta scoping', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        implement: { maxIterations: 1, deltaScopedReReview: false },
      },
    });
    expect(parsed.phases.implement.deltaScopedReReview).toBe(false);
  });

  it('accepts explicit deltaScopedReReview=true', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        implement: { maxIterations: 1, deltaScopedReReview: true },
      },
    });
    expect(parsed.phases.implement.deltaScopedReReview).toBe(true);
  });
});

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

describe('serve config', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults sweepIntervalSeconds to 0 when serve is absent', () => {
    const result = orchestratorConfigSchema.parse(baseConfig);
    expect(result.serve.sweepIntervalSeconds).toBe(0);
  });

  it('accepts an explicit positive sweepIntervalSeconds', () => {
    const result = orchestratorConfigSchema.parse({
      ...baseConfig,
      serve: { sweepIntervalSeconds: 120 },
    });
    expect(result.serve.sweepIntervalSeconds).toBe(120);
  });

  it('rejects a negative sweepIntervalSeconds', () => {
    expect(() =>
      orchestratorConfigSchema.parse({
        ...baseConfig,
        serve: { sweepIntervalSeconds: -1 },
      }),
    ).toThrow();
  });

  it('rejects a non-integer sweepIntervalSeconds', () => {
    expect(() =>
      orchestratorConfigSchema.parse({
        ...baseConfig,
        serve: { sweepIntervalSeconds: 1.5 },
      }),
    ).toThrow();
  });
});
