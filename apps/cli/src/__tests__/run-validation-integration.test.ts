import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunId, PhaseName } from '@ai-sdlc/domain';

describe('run-validation integration', () => {
  let repoRoot: string;
  let runsDir: string;

  const baseConfig = {
    phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
  };

  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'run-val-int-'));
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    runsDir = join(repoRoot, '.ai-runs');
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function compose(commands: string[]) {
    writeFileSync(
      join(repoRoot, '.ai-orchestrator.json'),
      JSON.stringify({ ...baseConfig, validation: { commands, timeout: 30 } }, null, 2),
    );
    const { composeRoot } = await import('@ai-sdlc/api/compose.js');
    return composeRoot({
      repoRoot,
      scriptPath: '/dev/null',
      runsDir,
      dbPath: ':memory:',
      runStartupSweeps: false,
    });
  }

  it('passes and persists a ValidationRun when all commands succeed', async () => {
    const c = await compose(['exit 0', 'echo hi']);
    const runUuid = '00000000-0000-0000-0000-0000000000c1';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-c1',
      issueNumber: 1,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);

    const out = await c.runValidation.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('validate'),
      cwd: repoRoot,
      logDir: join(runsDir, 'run-c1', 'validate'),
      commands: ['exit 0', 'echo hi'],
      timeoutSeconds: 30,
    });

    expect(out.passed).toBe(true);
    expect(c.validationRunRepository.listByRun(RunId(runUuid))).toHaveLength(1);
    expect(existsSync(join(runsDir, 'run-c1', 'validate', 'validation-result.json'))).toBe(true);
  });

  it('fails and records a Failure when a command fails (no short-circuit)', async () => {
    const c = await compose(['exit 0', 'exit 7']);
    const runUuid = '00000000-0000-0000-0000-0000000000c2';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-c2',
      issueNumber: 2,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);

    const out = await c.runValidation.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('validate'),
      cwd: repoRoot,
      logDir: join(runsDir, 'run-c2', 'validate'),
      commands: ['exit 0', 'exit 7'],
      timeoutSeconds: 30,
    });

    expect(out.passed).toBe(false);
    expect(out.validationRun.commands).toHaveLength(2);
    const failure = c.failureRepository.findLatestByRun(runUuid);
    expect(failure?.kind).toBe('validation_failed');
  });
});
