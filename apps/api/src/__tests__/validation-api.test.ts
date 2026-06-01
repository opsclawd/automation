import { describe, it, expect } from 'vitest';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import { RunId, PhaseName, type ValidationRun } from '@ai-sdlc/domain';

function compose() {
  return composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/bin/true',
    dbPath: ':memory:',
    runsDir: '/tmp/runs-test-' + Math.random(),
  });
}

const RUN_UUID = '00000000-0000-0000-0000-0000000000aa';

function seedRunRow(c: ReturnType<typeof compose>) {
  c.runRepository.insertIfNoActive({
    uuid: RUN_UUID,
    displayId: 'run-aa',
    issueNumber: 11,
    type: 'issue',
    status: 'running',
    completedPhases: [],
    startedAt: new Date(),
  } as never);
}

function sampleValidationRun(): ValidationRun {
  return {
    id: 'vr-aa',
    runId: RunId(RUN_UUID),
    phaseId: PhaseName('validate'),
    startedAt: new Date('2026-05-28T10:00:00Z'),
    completedAt: new Date('2026-05-28T10:00:30Z'),
    commands: [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 100,
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
        kind: 'build',
      },
      {
        command: 'pnpm typecheck',
        exitCode: 2,
        durationMs: 200,
        stdoutPath: 'validate/1-typecheck.stdout.log',
        stderrPath: 'validate/1-typecheck.stderr.log',
        outcome: 'failed',
        kind: 'typecheck',
        classifier: '12 errors',
      },
    ],
  };
}

describe('GET /api/runs/:uuid/validation', () => {
  it('returns serialized validation runs (no inlined output)', async () => {
    const c = compose();
    seedRunRow(c);
    c.validationRunRepository.save(sampleValidationRun());
    const app = await buildServer(c);
    const res = await app.inject({ url: `/api/runs/${RUN_UUID}/validation` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { validationRuns: Array<Record<string, unknown>> };
    expect(body.validationRuns).toHaveLength(1);
    const vr = body.validationRuns[0] as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(vr.id).toBe('vr-aa');
    expect(vr.phaseId).toBe('validate');
    expect(vr.passed).toBe(false);
    expect(vr.completedAt).toBe('2026-05-28T10:00:30.000Z');
    expect(vr.commands).toHaveLength(2);
    expect(vr.commands[0]).toMatchObject({
      command: 'pnpm build',
      kind: 'build',
      outcome: 'passed',
      exitCode: 0,
      durationMs: 100,
      stdoutPath: 'validate/0-build.stdout.log',
      stderrPath: 'validate/0-build.stderr.log',
      classifier: null,
    });
    expect(vr.commands[1]).toMatchObject({
      command: 'pnpm typecheck',
      kind: 'typecheck',
      outcome: 'failed',
      classifier: '12 errors',
    });
    expect(vr.commands[1].stdout).toBeUndefined();
    expect(vr.commands[1].stderr).toBeUndefined();
  });

  it('returns 400 for an invalid uuid', async () => {
    const c = compose();
    const app = await buildServer(c);
    const res = await app.inject({ url: '/api/runs/not-a-uuid/validation' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid run uuid');
  });

  it('returns an empty array for a valid uuid with no data', async () => {
    const c = compose();
    const app = await buildServer(c);
    const res = await app.inject({
      url: '/api/runs/00000000-0000-0000-0000-0000000000bb/validation',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { validationRuns: unknown[] }).validationRuns).toEqual([]);
  });
});
