import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ValidateHandler } from '../validate.js';
import { RunValidation } from '../../../run-validation.js';
import { FakeValidationPort } from '../../../test-doubles/fake-validation-port.js';
import { FakeValidationRunRepository } from '../../../test-doubles/fake-validation-run-repository.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { ValidationCommandResult } from '../../../ports/validation-port.js';

function allPassResults(): ValidationCommandResult[] {
  return [
    {
      command: 'pnpm build',
      exitCode: 0,
      durationMs: 1500,
      stdout: 'Build succeeded',
      stderr: '',
      stdoutPath: 'validate/0-build.stdout.log',
      stderrPath: 'validate/0-build.stderr.log',
      outcome: 'passed',
    },
  ];
}

function createTestFixture() {
  const git = new FakeGitPort();
  const validation = new FakeValidationPort();
  validation.result = allPassResults();
  const runValidation = new RunValidation({
    validation,
    validationRunRepository: new FakeValidationRunRepository(),
    idFactory: () => 'vr1',
    now: () => new Date('2026-06-16T00:00:00Z'),
  });
  const events: OrchestratorEvent[] = [];
  const artifacts = new FakeArtifactStore();
  const ctx: PhaseHandlerContext = {
    runId: 'human-readable-run',
    runUuid: '550e8400-e29b-41d4-a716-446655440000',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts,
    github: {} as PhaseHandlerContext['github'],
    git,
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
  };
  const handler = new ValidateHandler({
    runValidation,
    commands: ['pnpm build'],
    timeoutSeconds: 300,
    logDir: '/tmp/wt/.ai-runs/r1/validate',
  });

  return { handler, ctx, git, validation, events };
}

describe('ValidateHandler clean-worktree gate', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(() => {
    fixture = createTestFixture();
  });

  it('fails before running commands and reports every uncommitted source path', async () => {
    const { handler, ctx, git, validation } = fixture;
    git.statusByCwd.set(
      '/tmp/wt',
      ' M packages/application/src/a.ts\nA  packages/application/src/b.ts\n?? apps/web/src/c.tsx\n',
    );

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain('packages/application/src/a.ts');
      expect(result.failure.message).toContain('packages/application/src/b.ts');
      expect(result.failure.message).toContain('apps/web/src/c.tsx');
    }
    expect(validation.lastInput).toBeUndefined();
  });

  it('fails validation with canRetry false and does not write failure.json when uncommitted source paths exist, even if fixValidateEnabled is true', async () => {
    const { ctx, git, validation } = fixture;
    git.statusByCwd.set('/tmp/wt', ' M packages/application/src/a.ts\n');
    const handler = new ValidateHandler({
      runValidation: fixture.handler['opts'].runValidation,
      commands: ['pnpm build'],
      timeoutSeconds: 300,
      logDir: '/tmp/wt/.ai-runs/r1/validate',
      fixValidateEnabled: true,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.canRetry).toBe(false);
      expect(result.failure.message).toContain('packages/application/src/a.ts');
    }
    await expect(
      ctx.artifacts.read('550e8400-e29b-41d4-a716-446655440000', 'validate/failure.json'),
    ).rejects.toThrow();
    expect(validation.lastInput).toBeUndefined();
  });

  it('allows exact and wildcarded orchestrator artifacts', async () => {
    const { handler, ctx, git, validation } = fixture;
    git.statusByCwd.set(
      '/tmp/wt',
      ' M plan.md\n?? implementation-log-task-2.md\n?? task-context-step-2.md\n',
    );

    await expect(handler.run(ctx)).resolves.toMatchObject({ outcome: 'passed' });
    expect(validation.lastInput?.cwd).toBe('/tmp/wt');
  });

  it('fails closed when git status cannot be inspected', async () => {
    const { handler, ctx, git, validation } = fixture;
    vi.spyOn(git, 'status').mockRejectedValue(new Error('status unavailable'));

    const result = await handler.run(ctx);

    expect(result).toMatchObject({
      outcome: 'failed',
      failure: { kind: 'git_failed', phase: 'validate' },
    });
    expect(validation.lastInput).toBeUndefined();
  });

  it('truncates the reported uncommitted paths message when more than 10 dirty files exist', async () => {
    const { handler, ctx, git, validation, events } = fixture;
    const files = Array.from(
      { length: 15 },
      (_, i) => `packages/pkg/src/file-${String(i + 1).padStart(2, '0')}.ts`,
    );
    const statusOutput = files.map((f) => `?? ${f}\n`).join('');
    git.statusByCwd.set('/tmp/wt', statusOutput);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain('packages/pkg/src/file-01.ts');
      expect(result.failure.message).toContain('packages/pkg/src/file-10.ts');
      expect(result.failure.message).toContain('and 5 more');
      expect(result.failure.message).not.toContain('packages/pkg/src/file-11.ts');
    }
    expect(validation.lastInput).toBeUndefined();
    const failedEvent = events.find((e) => e.type === 'validate.failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.metadata as { paths?: string[] })?.paths).toHaveLength(15);
  });
});
