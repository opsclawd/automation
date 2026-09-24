import { describe, it, expect, vi } from 'vitest';
import {
  inspectLiveWorktreeConfiguration,
  formatLiveWorktreeConfigurationForPrompt,
  loadLiveWorktreeConfiguration,
  sanitizeConfigForReview,
  WORKTREE_ORCHESTRATOR_CONFIG_PATH,
} from '../live-worktree-config.js';

describe('live-worktree-config', () => {
  it('returns reader_unavailable when readWorktreeFile is not provided on context', async () => {
    const inspection = await inspectLiveWorktreeConfiguration({
      cwd: '/test/worktree',
    });

    expect(inspection.status).toBe('reader_unavailable');
    expect(inspection.path).toBe(WORKTREE_ORCHESTRATOR_CONFIG_PATH);

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('Status: UNAVAILABLE');
    expect(formatted).toContain(WORKTREE_ORCHESTRATOR_CONFIG_PATH);
  });

  it('returns missing when file does not exist in worktree', async () => {
    const readWorktreeFile = vi.fn().mockResolvedValue(undefined);
    const inspection = await inspectLiveWorktreeConfiguration({
      cwd: '/test/worktree',
      readWorktreeFile,
    });

    expect(readWorktreeFile).toHaveBeenCalledWith(
      '/test/worktree',
      WORKTREE_ORCHESTRATOR_CONFIG_PATH,
    );
    expect(inspection.status).toBe('missing');

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('Status: NOT PRESENT in active worktree');
    expect(formatted).toContain(WORKTREE_ORCHESTRATOR_CONFIG_PATH);
  });

  it('returns present when valid JSON configuration is read from worktree', async () => {
    const configContent = JSON.stringify(
      {
        validation: {
          commands: ['exit-gate:phase1', 'exit-gate:phase2', 'test:browser'],
        },
      },
      null,
      2,
    );
    const readWorktreeFile = vi.fn().mockImplementation(async (_cwd, rel) => {
      if (rel === WORKTREE_ORCHESTRATOR_CONFIG_PATH) return configContent;
      return undefined;
    });
    const inspection = await inspectLiveWorktreeConfiguration({
      cwd: '/test/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('present');
    expect(inspection.effectiveCommands).toEqual([
      'exit-gate:phase1',
      'exit-gate:phase2',
      'test:browser',
    ]);

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('Status: present');
    expect(formatted).toContain('```json');
    expect(formatted).toContain('exit-gate:phase1');
    expect(formatted).toContain('exit-gate:phase2');
    expect(formatted).toContain('test:browser');
  });

  it('returns malformed when configuration contains invalid JSON', async () => {
    const malformedContent = '{ "validation": { "commands": [ invalid json }';
    const readWorktreeFile = vi.fn().mockImplementation(async (_cwd, rel) => {
      if (rel === WORKTREE_ORCHESTRATOR_CONFIG_PATH) return malformedContent;
      return undefined;
    });
    const inspection = await inspectLiveWorktreeConfiguration({
      cwd: '/test/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('malformed');
    expect(inspection.raw).toBe(malformedContent);
    expect(inspection.error).toBeDefined();

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('Status: MALFORMED JSON');
    expect(formatted).toContain(malformedContent);
  });

  it('returns error when readWorktreeFile throws', async () => {
    const readWorktreeFile = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
    const inspection = await inspectLiveWorktreeConfiguration({
      cwd: '/test/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('error');
    expect(inspection.error).toContain('EACCES: permission denied');

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('Status: ERROR reading file (EACCES: permission denied)');
  });

  it('loadLiveWorktreeConfiguration combines inspect and format end-to-end', async () => {
    const configContent = JSON.stringify({
      validation: {
        commands: ['pnpm test'],
      },
    });
    const readWorktreeFile = vi.fn().mockImplementation(async (_cwd, rel) => {
      if (rel === WORKTREE_ORCHESTRATOR_CONFIG_PATH) return configContent;
      return undefined;
    });
    const promptString = await loadLiveWorktreeConfiguration({
      cwd: '/test/worktree',
      readWorktreeFile,
    });

    expect(promptString).toContain('Status: present');
    expect(promptString).toContain('pnpm test');
  });

  it('omits sensitive/unsupported fields such as notifications.runWebhookUrl while preserving validation commands and metadata (finding F-c7127793)', async () => {
    const sensitiveConfig = {
      executionPolicy: 'strict',
      notifications: {
        runWebhookUrl: 'https://secret.hooks.internal/token=super-secret-123',
      },
      agent: {
        apiKey: 'sk-secret-agent-key',
        profiles: { default: { model: 'claude' } },
      },
      internalSecretToken: 'top-secret',
      validation: {
        commands: ['exit-gate:phase1', 'test:browser'],
        tiers: [['exit-gate:phase1'], ['test:browser']],
        timeout: 900,
      },
    };

    const sanitized = sanitizeConfigForReview(sensitiveConfig);
    expect(sanitized.executionPolicy).toBe('strict');
    expect(sanitized.validation).toEqual({
      commands: ['exit-gate:phase1', 'test:browser'],
      tiers: [['exit-gate:phase1'], ['test:browser']],
      timeout: 900,
    });
    expect((sanitized as Record<string, unknown>).notifications).toBeUndefined();
    expect((sanitized as Record<string, unknown>).agent).toBeUndefined();
    expect((sanitized as Record<string, unknown>).internalSecretToken).toBeUndefined();

    // Verify end-to-end in prompt formatting
    const readWorktreeFile = vi.fn().mockImplementation(async (_cwd, rel) => {
      if (rel === WORKTREE_ORCHESTRATOR_CONFIG_PATH) return JSON.stringify(sensitiveConfig);
      return undefined;
    });
    const promptString = await loadLiveWorktreeConfiguration({
      cwd: '/test/worktree',
      readWorktreeFile,
    });

    expect(promptString).toContain('exit-gate:phase1');
    expect(promptString).toContain('test:browser');
    expect(promptString).not.toContain('super-secret-123');
    expect(promptString).not.toContain('runWebhookUrl');
    expect(promptString).not.toContain('sk-secret-agent-key');
    expect(promptString).not.toContain('top-secret');
  });

  it('resolves layered configuration across automation, automation-local, target, and target-local layers (findings F-28453ee5, F-9372c900)', async () => {
    // Automation layer defines base commands
    const automationBase = JSON.stringify({
      validation: {
        commands: ['exit-gate:phase1', 'exit-gate:phase2'],
        timeout: 600,
      },
    });
    // Target layer appends additionalCommands
    const targetBase = JSON.stringify({
      validation: {
        additionalCommands: ['test:browser'],
      },
    });
    // Target local appends another command
    const targetLocal = JSON.stringify({
      validation: {
        additionalCommands: ['test:e2e'],
      },
    });

    const readWorktreeFile = vi.fn().mockImplementation(async (cwd: string, rel: string) => {
      if (cwd === '/repo/automation' && rel === '.ai-orchestrator.json') return automationBase;
      if (cwd === '/repo/automation' && rel === '.ai-orchestrator.local.json') return undefined;
      if (cwd === '/repo/target/worktree' && rel === '.ai-orchestrator.json') return targetBase;
      if (cwd === '/repo/target/worktree' && rel === '.ai-orchestrator.local.json')
        return targetLocal;
      return undefined;
    });

    const inspection = await inspectLiveWorktreeConfiguration({
      automationRoot: '/repo/automation',
      cwd: '/repo/target/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('present');
    expect(inspection.effectiveCommands).toEqual([
      'exit-gate:phase1',
      'exit-gate:phase2',
      'test:browser',
      'test:e2e',
    ]);
    expect(inspection.layers).toHaveLength(4);
    expect(inspection.layers[0].status).toBe('present');
    expect(inspection.layers[1].status).toBe('missing');
    expect(inspection.layers[2].status).toBe('present');
    expect(inspection.layers[3].status).toBe('present');

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('exit-gate:phase1');
    expect(formatted).toContain('exit-gate:phase2');
    expect(formatted).toContain('test:browser');
    expect(formatted).toContain('test:e2e');
    expect(formatted).toContain('Automation Base');
    expect(formatted).toContain('Target Base');
    expect(formatted).toContain('Target Local');
  });

  it('target command replacement completely replaces inherited commands without duplicate merging', async () => {
    const automationBase = JSON.stringify({
      validation: {
        commands: ['pnpm build', 'pnpm test', 'pnpm lint'],
      },
    });
    // Target replaces commands entirely with issue #1270 commands
    const targetBase = JSON.stringify({
      validation: {
        commands: ['exit-gate:phase1', 'exit-gate:phase2', 'test:browser'],
      },
    });

    const readWorktreeFile = vi.fn().mockImplementation(async (cwd: string, rel: string) => {
      if (cwd === '/repo/automation' && rel === '.ai-orchestrator.json') return automationBase;
      if (cwd === '/repo/target/worktree' && rel === '.ai-orchestrator.json') return targetBase;
      return undefined;
    });

    const inspection = await inspectLiveWorktreeConfiguration({
      automationRoot: '/repo/automation',
      cwd: '/repo/target/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('present');
    expect(inspection.effectiveCommands).toEqual([
      'exit-gate:phase1',
      'exit-gate:phase2',
      'test:browser',
    ]);
    // The replaced commands should NOT be in effectiveCommands
    expect(inspection.effectiveCommands).not.toContain('pnpm build');
  });

  it('fails closed with status malformed when an inherited or local layer contains invalid JSON', async () => {
    const automationBase = JSON.stringify({
      validation: { commands: ['pnpm test'] },
    });
    const malformedLocal = '{ invalid json here';

    const readWorktreeFile = vi.fn().mockImplementation(async (cwd: string, rel: string) => {
      if (cwd === '/repo/automation' && rel === '.ai-orchestrator.json') return automationBase;
      if (cwd === '/repo/target/worktree' && rel === '.ai-orchestrator.local.json')
        return malformedLocal;
      return undefined;
    });

    const inspection = await inspectLiveWorktreeConfiguration({
      automationRoot: '/repo/automation',
      cwd: '/repo/target/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('malformed');
    expect(inspection.error).toBeDefined();

    const formatted = formatLiveWorktreeConfigurationForPrompt(inspection);
    expect(formatted).toContain('Status: MALFORMED JSON');
  });

  it('reads live target/worktree layers from ctx.cwd instead of ctx.targetRoot in cross-repo setup (finding F-c3b6ea2d)', async () => {
    const automationBase = JSON.stringify({
      validation: { commands: ['automation-gate'] },
    });
    const untouchedMainTarget = JSON.stringify({
      validation: { commands: ['stale-main-command'] },
    });
    const liveWorktreeTarget = JSON.stringify({
      validation: {
        commands: ['exit-gate:phase1', 'exit-gate:phase2', 'test:browser'],
      },
    });

    const readWorktreeFile = vi.fn().mockImplementation(async (cwd: string, rel: string) => {
      if (cwd === '/repo/automation' && rel === '.ai-orchestrator.json') return automationBase;
      if (cwd === '/repo/target-main' && rel === '.ai-orchestrator.json')
        return untouchedMainTarget;
      if (cwd === '/repo/target-main/.ai-worktrees/issue-63' && rel === '.ai-orchestrator.json')
        return liveWorktreeTarget;
      return undefined;
    });

    const inspection = await inspectLiveWorktreeConfiguration({
      automationRoot: '/repo/automation',
      targetRoot: '/repo/target-main',
      cwd: '/repo/target-main/.ai-worktrees/issue-63',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('present');
    expect(readWorktreeFile).toHaveBeenCalledWith(
      '/repo/target-main/.ai-worktrees/issue-63',
      '.ai-orchestrator.json',
    );
    expect(readWorktreeFile).not.toHaveBeenCalledWith('/repo/target-main', '.ai-orchestrator.json');
    expect(inspection.effectiveCommands).toEqual([
      'exit-gate:phase1',
      'exit-gate:phase2',
      'test:browser',
    ]);
  });

  it('reads live worktree base layer from ctx.cwd instead of targetRoot in single-repo setup (finding F-c3b6ea2d)', async () => {
    const untouchedMainBase = JSON.stringify({
      validation: { commands: ['main-default-command'] },
    });
    const liveWorktreeBase = JSON.stringify({
      validation: {
        commands: ['exit-gate:phase1', 'exit-gate:phase2', 'test:browser'],
      },
    });

    const readWorktreeFile = vi.fn().mockImplementation(async (cwd: string, rel: string) => {
      if (cwd === '/repo/main' && rel === '.ai-orchestrator.json') return untouchedMainBase;
      if (cwd === '/repo/main/.ai-worktrees/issue-1270' && rel === '.ai-orchestrator.json')
        return liveWorktreeBase;
      return undefined;
    });

    const inspection = await inspectLiveWorktreeConfiguration({
      automationRoot: '/repo/main',
      targetRoot: '/repo/main',
      cwd: '/repo/main/.ai-worktrees/issue-1270',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('present');
    expect(readWorktreeFile).toHaveBeenCalledWith(
      '/repo/main/.ai-worktrees/issue-1270',
      '.ai-orchestrator.json',
    );
    expect(readWorktreeFile).not.toHaveBeenCalledWith('/repo/main', '.ai-orchestrator.json');
    expect(inspection.effectiveCommands).toEqual([
      'exit-gate:phase1',
      'exit-gate:phase2',
      'test:browser',
    ]);
  });

  it('evaluates def.required and fails closed with status missing when a required layer is missing even if optional layer exists (finding F-c3b6ea2d)', async () => {
    const liveWorktreeTarget = JSON.stringify({
      validation: { commands: ['exit-gate:phase1'] },
    });

    // Automation base is required, but missing
    const readWorktreeFile = vi.fn().mockImplementation(async (cwd: string, rel: string) => {
      if (cwd === '/repo/automation' && rel === '.ai-orchestrator.json') return undefined;
      if (cwd === '/repo/target/worktree' && rel === '.ai-orchestrator.json')
        return liveWorktreeTarget;
      return undefined;
    });

    const inspection = await inspectLiveWorktreeConfiguration({
      automationRoot: '/repo/automation',
      targetRoot: '/repo/target',
      cwd: '/repo/target/worktree',
      readWorktreeFile,
    });

    expect(inspection.status).toBe('missing');
    expect(inspection.error).toContain('Missing required configuration');
  });
});
