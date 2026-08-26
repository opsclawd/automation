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

  const BASE_CONFIG = {
    validation: { commands: ['echo base1', 'echo base2'], timeout: 300 },
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
        validation: { additionalCommands: ['echo target2-additive'] },
      }),
    });
    writeFileSync(join(automationRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(target1Root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(target2Root, 'pnpm-workspace.yaml'), 'packages: []\n');
  });

  afterEach(() => {
    rmSync(automationRoot, { recursive: true, force: true });
    rmSync(target1Root, { recursive: true, force: true });
    rmSync(target2Root, { recursive: true, force: true });
  });

  it('persists fingerprint and sources reflecting replaced commands in target repo', async () => {
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

    const rawBody = readFileSync(configSourcesPath, 'utf8');
    const content = JSON.parse(rawBody);
    expect(content.fingerprint).toBeDefined();
    expect(content.sources).toBeDefined();

    const { loadLayeredConfig } = await import('@ai-sdlc/shared');
    const layered = loadLayeredConfig({ automationRoot, targetRoot: target1Root });
    const targetSource = layered.sources.find((s) => s.kind === 'target');
    expect(targetSource?.present).toBe(true);
    expect(layered.config.validation.commands).toEqual(['echo target1']);
    expect(typeof layered.fingerprint).toBe('string');
    expect(layered.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(content.fingerprint).toBe(layered.fingerprint);

    // Verify config-sources.json contains only paths + fingerprint (no file contents)
    expect(Object.keys(content).sort()).toEqual(['fingerprint', 'sources']);
    for (const src of content.sources) {
      expect(Object.keys(src).sort()).toEqual(['kind', 'path', 'present']);
    }
    expect(rawBody).not.toMatch(/echo target1/);
    expect(rawBody).not.toMatch(/api_key|secret|token/i);
  });

  it('persists fingerprint and sources reflecting additive commands in target repo', async () => {
    expect(existsSync(join(automationRoot, '.ai-orchestrator.json'))).toBe(true);
    expect(existsSync(join(target2Root, '.ai-orchestrator.json'))).toBe(true);

    const runId = '00000000-0000-0000-0000-0000000000d2';

    const testEnv = { ...process.env };
    delete testEnv.VITEST;

    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        runValidationScript,
        '--cwd',
        target2Root,
        '--run-id',
        runId,
        '--repo-root',
        automationRoot,
        '--target-repo-root',
        target2Root,
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

    const rawBody = readFileSync(configSourcesPath, 'utf8');
    const content = JSON.parse(rawBody);
    expect(content.fingerprint).toBeDefined();
    expect(content.sources).toBeDefined();

    const { loadLayeredConfig } = await import('@ai-sdlc/shared');
    const layered = loadLayeredConfig({ automationRoot, targetRoot: target2Root });
    const targetSource = layered.sources.find((s) => s.kind === 'target');
    expect(targetSource?.present).toBe(true);
    expect(layered.config.validation.commands).toEqual([
      'echo base1',
      'echo base2',
      'echo target2-additive',
    ]);
    expect(typeof layered.fingerprint).toBe('string');
    expect(layered.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(content.fingerprint).toBe(layered.fingerprint);

    // Verify config-sources.json contains only paths + fingerprint (no file contents)
    expect(Object.keys(content).sort()).toEqual(['fingerprint', 'sources']);
    for (const src of content.sources) {
      expect(Object.keys(src).sort()).toEqual(['kind', 'path', 'present']);
    }
    expect(rawBody).not.toMatch(/echo target2-additive/);
    expect(rawBody).not.toMatch(/api_key|secret|token/i);
  });
});
