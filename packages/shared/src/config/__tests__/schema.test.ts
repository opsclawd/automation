import { describe, it, expect } from 'vitest';
import { orchestratorConfigSchema } from '../schema.js';

describe('phases.implement.exemptUndeclaredFiles', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults exemptUndeclaredFiles to [] when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.phases.implement.exemptUndeclaredFiles).toEqual([]);
  });

  it('accepts explicit exemptUndeclaredFiles', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      phases: {
        ...baseConfig.phases,
        implement: { exemptUndeclaredFiles: ['docs/solutions/foo.md'] },
      },
    });
    expect(parsed.phases.implement.exemptUndeclaredFiles).toEqual(['docs/solutions/foo.md']);
  });
});

describe('serve config', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
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

describe('features.scopeContractEnforcement', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults to true when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.features.scopeContractEnforcement).toBe(true);
  });

  it('accepts false to disable', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      features: { scopeContractEnforcement: false },
    });
    expect(parsed.features.scopeContractEnforcement).toBe(false);
  });
});

describe('validation narrowByChangedFiles', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults validation.narrowByChangedFiles to true when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.validation.narrowByChangedFiles).toBe(true);
  });

  it('preserves explicit validation.narrowByChangedFiles true', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: { ...baseConfig.validation, narrowByChangedFiles: true },
    });
    expect(parsed.validation.narrowByChangedFiles).toBe(true);
  });

  it('preserves explicit validation.narrowByChangedFiles false', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: { ...baseConfig.validation, narrowByChangedFiles: false },
    });
    expect(parsed.validation.narrowByChangedFiles).toBe(false);
  });

  it('rejects a non-boolean validation.narrowByChangedFiles value', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      validation: { ...baseConfig.validation, narrowByChangedFiles: 'yes' },
    });
    expect(result.success).toBe(false);
  });
});

describe('validation additionalCommands', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('accepts non-empty validation.additionalCommands entries', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        additionalCommands: ['pnpm lint', 'pnpm build'],
      },
    });
    expect(parsed.validation.additionalCommands).toEqual(['pnpm lint', 'pnpm build']);
  });

  it('accepts an empty validation.additionalCommands list', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        additionalCommands: [],
      },
    });
    expect(parsed.validation.additionalCommands).toEqual([]);
  });

  it('rejects blank validation.additionalCommands entries', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        additionalCommands: ['   '],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('validation selfVerifyCommands', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('accepts non-empty validation.selfVerifyCommands entries', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        selfVerifyCommands: ['pnpm typecheck', 'pnpm lint'],
      },
    });
    expect(parsed.validation.selfVerifyCommands).toEqual(['pnpm typecheck', 'pnpm lint']);
  });

  it('accepts an empty validation.selfVerifyCommands list', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        selfVerifyCommands: [],
      },
    });
    expect(parsed.validation.selfVerifyCommands).toEqual([]);
  });

  it('rejects blank validation.selfVerifyCommands entries', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        selfVerifyCommands: ['   '],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('validation commands', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('continues to reject an empty validation.commands list', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        commands: [],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('executionPolicy', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults executionPolicy to standard when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.executionPolicy).toBe('standard');
  });

  it('rejects legacy executionPolicy explicitly', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      executionPolicy: 'legacy',
    });
    expect(result.success).toBe(false);
  });

  it('accepts standard executionPolicy', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      executionPolicy: 'standard',
    });
    expect(parsed.executionPolicy).toBe('standard');
  });

  it('accepts strict executionPolicy', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      executionPolicy: 'strict',
    });
    expect(parsed.executionPolicy).toBe('strict');
  });

  it('rejects invalid executionPolicy values', () => {
    const invalidValues = ['legacy', 'fast', 'relaxed', 'custom', '', 'LEGACY', 123];
    for (const val of invalidValues) {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        executionPolicy: val,
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('notifications config', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults notifications to {} when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.notifications).toEqual({});
    expect(parsed.notifications?.runWebhookUrl).toBeUndefined();
  });

  it('accepts a valid runWebhookUrl', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      notifications: {
        runWebhookUrl: 'https://ntfy.sh/my-topic',
      },
    });
    expect(parsed.notifications.runWebhookUrl).toBe('https://ntfy.sh/my-topic');
  });

  it('rejects invalid runWebhookUrl values that are not URLs', () => {
    const invalidUrls = ['not-a-url', 'http://', '://bad', ''];
    for (const val of invalidUrls) {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        notifications: {
          runWebhookUrl: val,
        },
      });
      expect(result.success).toBe(false);
    }
  });

  it('preserves strictObject behavior and rejects unknown root properties', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      notifications: {
        runWebhookUrl: 'https://ntfy.sh/my-topic',
      },
      unknownProperty: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('governance config (#1142)', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewConvergence: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('defaults governance.protectedPaths to [] when omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.governance).toEqual({ protectedPaths: [] });
  });

  it('accepts explicit governance.protectedPaths', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      governance: {
        protectedPaths: ['config/component-license-registry.json', 'governance/policies.json'],
      },
    });
    expect(parsed.governance.protectedPaths).toEqual([
      'config/component-license-registry.json',
      'governance/policies.json',
    ]);
  });
});

describe('validation commandScopes (#1207)', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: { skip: [] },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  it('allows commandScopes to be omitted', () => {
    const parsed = orchestratorConfigSchema.parse(baseConfig);
    expect(parsed.validation.commandScopes).toBeUndefined();
  });

  it('accepts valid validation.commandScopes dictionary', () => {
    const parsed = orchestratorConfigSchema.parse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        commandScopes: {
          'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
          'pnpm test:db': ['packages/infrastructure/src/db', '@ai-sdlc/infrastructure'],
        },
      },
    });
    expect(parsed.validation.commandScopes).toEqual({
      'pnpm test:assembly': ['packages/infrastructure/src/ffmpeg'],
      'pnpm test:db': ['packages/infrastructure/src/db', '@ai-sdlc/infrastructure'],
    });
  });

  it('rejects blank command scope entry strings', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        commandScopes: {
          'pnpm test:assembly': ['   '],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object commandScopes', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...baseConfig,
      validation: {
        ...baseConfig.validation,
        commandScopes: ['packages/infrastructure'],
      },
    });
    expect(result.success).toBe(false);
  });
});
