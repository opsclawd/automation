import { describe, it, expect } from 'vitest';
import { orchestratorConfigSchema } from '../schema.js';

describe('scheduler config', () => {
  const baseConfig = {
    validation: { commands: ['pnpm test'], timeout: 60 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 5 },
      implement: { maxIterations: 1 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  describe('defaults scheduler_config_defaults_are_safe when scheduler is omitted', () => {
    it('omitted scheduler config yields globalConcurrency 1', () => {
      const parsed = orchestratorConfigSchema.parse(baseConfig);
      expect(parsed.scheduler.globalConcurrency).toBe(1);
    });

    it('omitted scheduler config yields pollIntervalMs 2000', () => {
      const parsed = orchestratorConfigSchema.parse(baseConfig);
      expect(parsed.scheduler.pollIntervalMs).toBe(2000);
    });
  });

  describe('rejects scheduler_config_requires_positive_integers and unknown keys', () => {
    it('rejects globalConcurrency of zero', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 0, pollIntervalMs: 2000 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative globalConcurrency', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: -1, pollIntervalMs: 2000 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects fractional globalConcurrency', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1.5, pollIntervalMs: 2000 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects pollIntervalMs of zero', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative pollIntervalMs', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: -500 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects fractional pollIntervalMs', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 1500.5 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown scheduler keys', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 2000, typo: true },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('accepts scheduler_config_accepts_explicit_limits', () => {
    it('accepts explicit globalConcurrency override', () => {
      const parsed = orchestratorConfigSchema.parse({
        ...baseConfig,
        scheduler: { globalConcurrency: 4, pollIntervalMs: 2000 },
      });
      expect(parsed.scheduler.globalConcurrency).toBe(4);
    });

    it('accepts explicit pollIntervalMs override', () => {
      const parsed = orchestratorConfigSchema.parse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 5000 },
      });
      expect(parsed.scheduler.pollIntervalMs).toBe(5000);
    });

    it('accepts both explicit overrides', () => {
      const parsed = orchestratorConfigSchema.parse({
        ...baseConfig,
        scheduler: { globalConcurrency: 8, pollIntervalMs: 3000 },
      });
      expect(parsed.scheduler.globalConcurrency).toBe(8);
      expect(parsed.scheduler.pollIntervalMs).toBe(3000);
    });
  });

  describe('defaults scheduler config defaults shutdown grace', () => {
    it('omitted shutdownGraceMs yields 30000', () => {
      const parsed = orchestratorConfigSchema.parse(baseConfig);
      expect(parsed.scheduler.shutdownGraceMs).toBe(30000);
    });
  });

  describe('rejects scheduler config rejects nonpositive shutdown grace', () => {
    it('rejects shutdownGraceMs of zero', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 2000, shutdownGraceMs: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative shutdownGraceMs', () => {
      const result = orchestratorConfigSchema.safeParse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 2000, shutdownGraceMs: -1000 },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('accepts scheduler config accepts explicit shutdown grace', () => {
    it('accepts explicit shutdownGraceMs override', () => {
      const parsed = orchestratorConfigSchema.parse({
        ...baseConfig,
        scheduler: { globalConcurrency: 1, pollIntervalMs: 2000, shutdownGraceMs: 60000 },
      });
      expect(parsed.scheduler.shutdownGraceMs).toBe(60000);
    });
  });
});
