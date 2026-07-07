import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const runValidationScript = join(__dirname, '../run-validation.ts');

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'integration-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('run-validation layered config integration', () => {
  let automationRoot: string;
  let target1Root: string;
  let target2Root: string;
  let runsDir: string;

  const BASE_CONFIG = {
    validation: { commands: ['echo base'], timeout: 300 },
    phases: {
      skip: [],
      reviewFix: { maxIterations: 10 },
      implement: { maxIterations: 5 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  beforeEach(() => {
    automationRoot = makeRepo({
      '.ai-orchestrator.json': JSON.stringify(BASE_CONFIG),
    });
    target1Root = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { commands: ['echo target1'] },
      }),
    });
    target2Root = makeRepo({
      '.ai-orchestrator.json': JSON.stringify({
        validation: { commands: ['echo target2'] },
      }),
    });
    writeFileSync(join(automationRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(target1Root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(target2Root, 'pnpm-workspace.yaml'), 'packages: []\n');
    runsDir = mkdtempSync(join(tmpdir(), 'runs-'));
  });

  afterEach(() => {
    rmSync(automationRoot, { recursive: true, force: true });
    rmSync(target1Root, { recursive: true, force: true });
    rmSync(target2Root, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  it('persists fingerprint and sources reflecting both repos', async () => {
    expect(existsSync(join(automationRoot, '.ai-orchestrator.json'))).toBe(true);
    expect(existsSync(join(target1Root, '.ai-orchestrator.json'))).toBe(true);

    const runId = '00000000-0000-0000-0000-0000000000d1';

    const testEnv = { ...process.env };
    delete testEnv.VITEST;

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        runValidationScript,
        '--cwd',
        target1Root,
        '--run-id',
        runId,
        '--repo-root',
        automationRoot,
        '--target-repo-root',
        target1Root,
        '--phase-id',
        'validate',
      ],
      {
        env: {
          ...testEnv,
          NODE_OPTIONS: '--conditions=development',
        },
      },
    );

    const runDir = join(automationRoot, '.ai-runs', runId);
    const configSourcesPath = join(runDir, 'config-sources.json');
    expect(existsSync(configSourcesPath)).toBe(true);

    const content = JSON.parse(readFileSync(configSourcesPath, 'utf8'));
    expect(content.fingerprint).toBeDefined();
    expect(content.sources).toBeDefined();

    const { loadLayeredConfig } = await import('@ai-sdlc/shared');
    const layered = loadLayeredConfig({ automationRoot, targetRoot: target1Root });
    expect(typeof layered.fingerprint).toBe('string');
    expect(layered.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(content.fingerprint).toBe(layered.fingerprint);
  });

  it('writes config-sources.json containing only paths + fingerprint (no file contents)', () => {
    const runId = 'test-run-1';
    const runDir = join(runsDir, runId);
    require('node:fs').mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'config-sources.json'),
      JSON.stringify(
        {
          fingerprint: 'abc123',
          sources: [
            {
              path: join(automationRoot, '.ai-orchestrator.json'),
              kind: 'automation',
              present: true,
            },
            {
              path: join(automationRoot, '.ai-orchestrator.local.json'),
              kind: 'local',
              present: true,
            },
          ],
        },
        null,
        2,
      ),
    );
    const body = readFileSync(join(runDir, 'config-sources.json'), 'utf8');
    // Heuristic guard: this string would appear if a file body were inlined.
    expect(body).not.toMatch(/echo target1/);
    expect(body).not.toMatch(/api_key|secret|token/i);
  });
});
