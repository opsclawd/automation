import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import { RunValidation } from '../run-validation.js';
import { FakeValidationPort } from '../test-doubles/fake-validation-port.js';
import { FakeValidationRunRepository } from '../test-doubles/fake-validation-run-repository.js';

const RUN = RunId('44444444-4444-4444-4444-444444444444');

function makeUseCase(port: FakeValidationPort, repo: FakeValidationRunRepository) {
  let n = 0;
  const useCase = new RunValidation({
    validation: port,
    validationRunRepository: repo,
    idFactory: () => `vrun-${++n}`,
    now: () => new Date('2026-05-28T12:00:00Z'),
  });
  return { useCase };
}

function passResult(i: number, command: string) {
  const slug = command.replace(/^pnpm\s+/, '').replace(/[^a-z0-9]+/g, '-');
  return {
    command,
    exitCode: 0,
    durationMs: 1,
    stdout: '',
    stderr: '',
    stdoutPath: `validate/${i}-${slug}.stdout.log`,
    stderrPath: `validate/${i}-${slug}.stderr.log`,
    outcome: 'passed' as const,
  };
}

function failResult(i: number, command: string, exitCode: number) {
  const slug = command.replace(/^pnpm\s+/, '').replace(/[^a-z0-9]+/g, '-');
  return {
    command,
    exitCode,
    durationMs: 10,
    stdout: '',
    stderr: 'boom',
    stdoutPath: `validate/${i}-${slug}.stdout.log`,
    stderrPath: `validate/${i}-${slug}.stderr.log`,
    outcome: 'failed' as const,
  };
}

function skipResult(i: number, command: string) {
  const slug = command.replace(/^pnpm\s+/, '').replace(/[^a-z0-9]+/g, '-');
  return {
    command,
    exitCode: 0,
    durationMs: 0,
    stdout: '',
    stderr: 'Skipped: no "test:bash" script in package.json at /work\n',
    stdoutPath: `validate/${i}-${slug}.stdout.log`,
    stderrPath: `validate/${i}-${slug}.stderr.log`,
    outcome: 'skipped' as const,
  };
}

describe('RunValidation', () => {
  it('persists a ValidationRun with one record per command, preserving order', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build'), failResult(1, 'pnpm typecheck', 2)];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);

    const out = await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/work/.ai-runs/x/validate',
      commands: ['pnpm build', 'pnpm typecheck'],
      timeoutSeconds: 300,
    });

    expect(out.passed).toBe(false);
    expect(out.validationRun.commands.map((c) => c.command)).toEqual([
      'pnpm build',
      'pnpm typecheck',
    ]);
    expect(out.validationRun.commands[1].outcome).toBe('failed');
    expect(out.validationRun.commands[0].kind).toBe('build');
    const persisted = repo.findById('vrun-1');
    expect(persisted).not.toBeNull();
    expect(persisted!.commands).toHaveLength(2);
    expect(persisted!.completedAt).toBeDefined();
  });

  it('passes when a skipped command sits alongside passing commands, and skips no classifier', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build'), skipResult(1, 'pnpm test:bash')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);

    const out = await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/work/.ai-runs/x/validate',
      commands: ['pnpm build', 'pnpm test:bash'],
      timeoutSeconds: 300,
    });

    expect(out.passed).toBe(true);
    expect(out.failure).toBeUndefined();
    expect(out.validationRun.commands[1].outcome).toBe('skipped');
    expect(out.validationRun.commands[1].classifier).toBeUndefined();
  });

  it('passes when every command passed', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);
    const out = await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm build'],
      timeoutSeconds: 300,
    });
    expect(out.passed).toBe(true);
  });

  it('throws on an empty command list', async () => {
    const port = new FakeValidationPort();
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);
    await expect(
      useCase.execute({
        runId: RUN,
        phaseId: PhaseName('validate'),
        cwd: '/work',
        logDir: '/d',
        commands: [],
        timeoutSeconds: 300,
      }),
    ).rejects.toThrow(/no validation commands/i);
  });

  it('forwards logDir/cwd/timeout to the port', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);
    await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/abs/validate',
      commands: ['pnpm build'],
      timeoutSeconds: 120,
    });
    expect(port.lastInput).toMatchObject({
      cwd: '/work',
      logDir: '/abs/validate',
      timeoutSeconds: 120,
    });
  });

  it('classifies command kinds and emits a validation_failed Failure', async () => {
    const port = new FakeValidationPort();
    port.result = [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 5,
        stdout: 'ok',
        stderr: '',
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
      },
      {
        command: 'pnpm typecheck',
        exitCode: 2,
        durationMs: 9,
        stdout: '',
        stderr: 'error TS2345',
        stdoutPath: 'validate/1-typecheck.stdout.log',
        stderrPath: 'validate/1-typecheck.stderr.log',
        outcome: 'failed',
      },
    ];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);
    const out = await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm build', 'pnpm typecheck'],
      timeoutSeconds: 300,
    });
    expect(out.validationRun.commands[0].kind).toBe('build');
    expect(out.validationRun.commands[1].kind).toBe('typecheck');
    expect(out.validationRun.commands[1].classifier).toContain('error TS2345');
  });

  it('classifies parse_error outcome and attaches failure', async () => {
    const port = new FakeValidationPort();
    port.result = [
      {
        command: "printf '%s\\n' 'unterminated",
        exitCode: 2,
        durationMs: 5,
        stdout: '',
        stderr: 'sh: 1: Syntax error: Unterminated quoted string\n',
        stdoutPath: 'validate/0-cmd.stdout.log',
        stderrPath: 'validate/0-cmd.stderr.log',
        outcome: 'parse_error',
      },
    ];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);
    const out = await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ["printf '%s\\n' 'unterminated"],
      timeoutSeconds: 300,
    });
    expect(out.passed).toBe(false);
    expect(out.validationRun.commands[0].outcome).toBe('parse_error');
    expect(out.validationRun.commands[0].classifier).toContain(
      'Command failed to parse (shell syntax error)',
    );
    expect(out.failure).toBeDefined();
    expect(out.failure?.kind).toBe('validation_failed');
  });
  it('emits no Failure when validation passes', async () => {
    const port = new FakeValidationPort();
    port.result = [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 5,
        stdout: '',
        stderr: '',
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
      },
    ];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);
    await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/w',
      logDir: '/d',
      commands: ['pnpm build'],
      timeoutSeconds: 300,
    });
  });

  it('forwards nested argv validation commands unchanged to ValidationPort', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);

    const argvCommand = ['pnpm', 'exec', 'eslint', 'apps/app/app/position/[id].tsx'];
    await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm build', argvCommand],
      timeoutSeconds: 300,
    });

    expect(port.lastInput?.commands).toEqual(['pnpm build', argvCommand]);
  });

  it('RunValidation forwards a full scope summary unchanged', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);

    await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm build'],
      timeoutSeconds: 300,
      validationScope: { validationMode: 'full' },
    });

    expect(port.lastInput?.validationScope).toEqual({ validationMode: 'full' });
  });

  it('RunValidation forwards a narrow closure unchanged', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm --filter @ai-sdlc/application build')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);

    const narrowedPackages = [
      '@ai-sdlc/application',
      '@ai-sdlc/infrastructure',
      '@ai-sdlc/api',
      '@ai-sdlc/cli',
    ];
    await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm --filter @ai-sdlc/application build'],
      timeoutSeconds: 300,
      validationScope: {
        validationMode: 'narrow',
        narrowedPackages,
      },
    });

    expect(port.lastInput?.validationScope).toEqual({
      validationMode: 'narrow',
      narrowedPackages: [
        '@ai-sdlc/application',
        '@ai-sdlc/infrastructure',
        '@ai-sdlc/api',
        '@ai-sdlc/cli',
      ],
    });
  });

  it('legacy callers may omit scope metadata', async () => {
    const port = new FakeValidationPort();
    port.result = [passResult(0, 'pnpm build')];
    const repo = new FakeValidationRunRepository();
    const { useCase } = makeUseCase(port, repo);

    await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm build'],
      timeoutSeconds: 300,
    });

    expect(port.lastInput?.validationScope).toBeUndefined();
  });
});
