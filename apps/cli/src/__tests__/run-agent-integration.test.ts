import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

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
});
