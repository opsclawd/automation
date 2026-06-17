import { describe, it, expect } from 'vitest';
import { ValidateHandler } from '../validate.js';
import { RunValidation } from '../../../run-validation.js';
import { FakeValidationPort } from '../../../test-doubles/fake-validation-port.js';
import { FakeValidationRunRepository } from '../../../test-doubles/fake-validation-run-repository.js';
import { FakeFailureRepository } from '../../../test-doubles/fake-failure-repository.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
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

function deps(passing: 'passed' | 'failed') {
  const validation = new FakeValidationPort();
  if (passing === 'passed') {
    validation.result = allPassResults();
  } else {
    validation.result = [
      {
        command: 'pnpm build',
        exitCode: 1,
        durationMs: 1500,
        stdout: '',
        stderr: 'Build failed',
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'failed',
      },
    ];
  }
  const runValidation = new RunValidation({
    validation,
    validationRunRepository: new FakeValidationRunRepository(),
    failureRepository: new FakeFailureRepository(),
    idFactory: () => 'vr1',
    now: () => new Date('2026-06-16T00:00:00Z'),
  });
  return { runValidation, validation };
}

function makeCtx() {
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'human-readable-run',
    runUuid: '550e8400-e29b-41d4-a716-446655440000',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts: {} as PhaseHandlerContext['artifacts'],
    github: {} as PhaseHandlerContext['github'],
    git: {} as PhaseHandlerContext['git'],
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

describe('ValidateHandler', () => {
  it('returns passed when all validation commands pass', async () => {
    const { runValidation } = deps('passed');
    const { ctx } = makeCtx();
    const result = await new ValidateHandler({
      runValidation,
      commands: ['pnpm build'],
      timeoutSeconds: 300,
      logDir: '/tmp/wt/.ai-runs/r1/validate',
    }).run(ctx);
    expect(result.outcome).toBe('passed');
  });
});
