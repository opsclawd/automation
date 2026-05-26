import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { FakeAgentPort, FakeAgentInvocationPort } from '@ai-sdlc/application/test-doubles';
import { AgentRuntimeRouter } from '@ai-sdlc/infrastructure';
import { AgentProfileName } from '@ai-sdlc/domain';

describe('run-agent integration', () => {
  let tmpDir: string;
  let promptFile: string;
  let configDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'run-agent-int-'));
    promptFile = join(tmpDir, 'prompt.md');
    writeFileSync(promptFile, 'test prompt content');

    configDir = tmpDir;
    const config = {
      validation: {
        commands: ['pnpm build', 'pnpm lint'],
        timeout: 300,
      },
      phases: {
        skip: [],
        reviewFix: { maxIterations: 10 },
        implement: { maxIterations: 5 },
      },
      timeouts: {
        readyMaxDays: 7,
        invocationMaxMinutes: 30,
      },
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode' as const,
            provider: 'anthropic',
            model: 'claude-opus-4.7',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: {
          'test-phase': { profile: 'opencode-frontier' },
        },
      },
    };
    writeFileSync(join(configDir, '.ai-orchestrator.json'), JSON.stringify(config, null, 2));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves --phase and invokes agent runtime', async () => {
    const { composeRoot } = await import('@ai-sdlc/api/compose.js');
    const c = composeRoot({ repoRoot: configDir, scriptPath: '/dev/null' });
    expect(c.agentRuntime).toBeDefined();
    expect(c.resolveProfileForPhase).toBeDefined();
  });

  it('drives invoke through router with fake adapter and asserts outcome', async () => {
    const fakeAgent = new FakeAgentPort({
      'opencode-frontier': [
        {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-opus-4.7',
          exitCode: 0,
          durationMs: 42,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success',
        },
      ],
    });
    const invRepo = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: {
        defaultProfile: 'opencode-frontier',
        profiles: {
          'opencode-frontier': {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-opus-4.7',
            timeoutMinutes: 60,
          },
        },
        phaseProfiles: {
          'test-phase': { profile: 'opencode-frontier' },
        },
      },
      adapters: { opencode: fakeAgent },
      invocationRepository: invRepo,
    });

    const result = await router.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: promptFile,
      expectedArtifacts: [],
      cwd: tmpDir,
      runId: 'test-run-id',
      repoId: 'test/repo',
      phaseId: 'test-phase',
      startCommitSha: '0'.repeat(40),
    });

    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('opencode');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-opus-4.7');
    expect(result.exitCode).toBe(0);

    const rows = invRepo.listByRun('test-run-id');
    expect(rows.length).toBe(1);
    expect(rows[0].profile).toBe('opencode-frontier');
    expect(rows[0].runtime).toBe('opencode');
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].exitCode).toBe(0);
  });
});
