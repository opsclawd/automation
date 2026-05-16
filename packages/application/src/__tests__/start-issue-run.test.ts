import { describe, expect, it } from 'vitest';
import type { Failure, Run } from '@ai-sdlc/domain';
import { StartIssueRun } from '../start-issue-run.js';
import type {
  ClassifyExitFn,
  FailureRepositoryPort,
  RunBashScriptFn,
  RunDirectoryFactory,
  RunDirectoryHandle,
  RunRepositoryPort,
  RunRepositoryUpdatePatch,
} from '../ports.js';

interface RecordedUpdate {
  uuid: string;
  patch: RunRepositoryUpdatePatch;
}

class FakeRunRepository implements RunRepositoryPort {
  inserted: Run[] = [];
  updates: RecordedUpdate[] = [];
  active = new Set<number>();
  insertIfNoActive(run: Run): void {
    if (this.active.has(run.issueNumber)) {
      throw new Error(`An active run already exists for issue ${run.issueNumber}`);
    }
    this.inserted.push(run);
    this.active.add(run.issueNumber);
  }
  update(uuid: string, patch: RunRepositoryUpdatePatch): void {
    this.updates.push({ uuid, patch });
  }
  finalPatch(uuid: string): RunRepositoryUpdatePatch {
    const merged: RunRepositoryUpdatePatch = {};
    for (const u of this.updates) {
      if (u.uuid === uuid) Object.assign(merged, u.patch);
    }
    return merged;
  }
}

class FakeFailureRepository implements FailureRepositoryPort {
  records: Failure[] = [];
  insert(failure: Failure): void {
    this.records.push(failure);
  }
  findLatestByRun(runUuid: string): Failure | undefined {
    return this.records.filter((f) => f.runUuid === runUuid).at(-1);
  }
}

const fakeClassifyExit: ClassifyExitFn = (input) => ({
  runUuid: input.runUuid ?? 'fake-uuid',
  kind: 'command_failed',
  message: `script exited with code ${input.exitCode}`,
  exitCode: input.exitCode,
  canRetry: false,
  suggestedAction: 'Inspect combined.log and stderr.log for the cause.',
  artifacts: input.artifacts ?? [],
  detectedAt: input.detectedAt ?? new Date(),
});

interface FakeDir extends RunDirectoryHandle {
  writes: Run[];
  failureWrites: Failure[];
  combinedLogContent: string;
}

function fakeDirectoryFactory(opts?: {
  failWrite?: boolean;
  failCreate?: boolean;
  combinedLogContent?: string;
}): {
  factory: RunDirectoryFactory;
  dirs: FakeDir[];
} {
  const dirs: FakeDir[] = [];
  const factory: RunDirectoryFactory = ({ run }) => {
    if (opts?.failCreate) throw new Error('mkdir failed');
    const dir: FakeDir = {
      runRoot: `/fake/${run.displayId}`,
      paths: {
        stdoutLogPath: `/fake/${run.displayId}/stdout.log`,
        stderrLogPath: `/fake/${run.displayId}/stderr.log`,
        combinedLogPath: `/fake/${run.displayId}/combined.log`,
      },
      writes: [],
      failureWrites: [],
      combinedLogContent: opts?.combinedLogContent ?? '',
      writeRunJson(r) {
        if (opts?.failWrite) throw new Error('disk full');
        this.writes.push(r);
      },
      writeFailureJson(f) {
        if (opts?.failWrite) throw new Error('disk full');
        this.failureWrites.push(f);
      },
      readCombinedLog() {
        return this.combinedLogContent;
      },
    };
    dirs.push(dir);
    return dir;
  };
  return { factory, dirs };
}

function fakeBash(result: { exitCode: number; durationMs?: number } | Error): {
  fn: RunBashScriptFn;
  calls: Parameters<RunBashScriptFn>[0][];
} {
  const calls: Parameters<RunBashScriptFn>[0][] = [];
  const fn: RunBashScriptFn = async (input) => {
    calls.push(input);
    if (result instanceof Error) throw result;
    return { exitCode: result.exitCode, durationMs: result.durationMs ?? 5 };
  };
  return { fn, calls };
}

const fixedNow = () => new Date('2026-05-13T19:23:00Z');

describe('StartIssueRun', () => {
  it('marks run passed on exit 0 and writes final run.json', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory, dirs } = fakeDirectoryFactory();
    const { fn: bash, calls } = fakeBash({ exitCode: 0, durationMs: 42 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    const out = await usecase.execute({ issueNumber: 42 });
    expect(out.status).toBe('passed');
    expect(out.exitCode).toBe(0);
    expect(out.displayId).toBe('issue-42-20260513-192300000');
    const patch = repo.finalPatch(out.uuid);
    expect(patch.status).toBe('passed');
    expect(patch.exitCode).toBe(0);
    expect(patch.durationMs).toBe(42);
    expect(dirs[0]!.writes).toHaveLength(1);
    expect(calls[0]!.env.AI_RUN_UUID).toBe(out.uuid);
    expect(calls[0]!.env.AI_ISSUE_NUMBER).toBe('42');
  });

  it('marks run failed on non-zero exit and sets failureReason', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash({ exitCode: 3 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    const out = await usecase.execute({ issueNumber: 7 });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(3);
    const patch = repo.finalPatch(out.uuid);
    expect(patch.status).toBe('failed');
    expect(patch.failureReason).toMatch(/3/);
  });

  it('refuses to start a second active run for the same issue', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    repo.active.add(7);
    const { factory } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash({ exitCode: 0 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    await expect(usecase.execute({ issueNumber: 7 })).rejects.toThrow(/active run/i);
  });

  it('passes optional env vars only when provided', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory();
    const { fn: bash, calls } = fakeBash({ exitCode: 0 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      baseBranch: 'develop',
      model: 'gpt-4',
      agentCli: 'codex',
      now: fixedNow,
    });
    await usecase.execute({ issueNumber: 10 });
    expect(calls[0]!.env.AI_BASE_BRANCH).toBe('develop');
    expect(calls[0]!.env.AI_MODEL).toBe('gpt-4');
    expect(calls[0]!.env.AI_RUNTIME).toBe('codex');
  });

  it('omits optional env vars when deps are not provided', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory();
    const { fn: bash, calls } = fakeBash({ exitCode: 0 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    await usecase.execute({ issueNumber: 1 });
    expect(calls[0]!.env.AI_BASE_BRANCH).toBeUndefined();
    expect(calls[0]!.env.AI_MODEL).toBeUndefined();
    expect(calls[0]!.env.AI_RUNTIME).toBeUndefined();
  });

  it('marks run failed when directory creation fails', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory({ failCreate: true });
    const { fn: bash } = fakeBash({ exitCode: 0 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    await expect(usecase.execute({ issueNumber: 5 })).rejects.toThrow(/mkdir/);
    expect(repo.inserted).toHaveLength(1);
    const patch = repo.finalPatch(repo.inserted[0]!.uuid);
    expect(patch.status).toBe('failed');
    expect(patch.exitCode).toBe(-1);
    expect(patch.failureReason).toMatch(/mkdir/);
  });

  it('surfaces writeRunJson failures as failureReason on the DB row', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory({ failWrite: true });
    const { fn: bash } = fakeBash({ exitCode: 0 });
    const errors: string[] = [];
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
      logger: { error: (m) => errors.push(m) },
    });
    const out = await usecase.execute({ issueNumber: 3 });
    expect(out.status).toBe('passed');
    expect(errors[0]).toMatch(/Failed to write run\.json/);
    const patch = repo.finalPatch(out.uuid);
    expect(patch.failureReason).toMatch(/run\.json write failed/);
  });

  it('marks run failed when runBashScript throws', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory, dirs } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash(new Error('spawn EACCES'));
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    await expect(usecase.execute({ issueNumber: 8 })).rejects.toThrow(/spawn EACCES/);
    const patch = repo.finalPatch(repo.inserted[0]!.uuid);
    expect(patch.status).toBe('failed');
    expect(patch.failureReason).toMatch(/spawn EACCES/);
    expect(patch.exitCode).toBe(-1);
    expect(dirs[0]!.writes).toHaveLength(1);
  });

  it('classifies failure and persists failure.json on non-zero exit', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const classifierThatDetectsMissingArtifact: ClassifyExitFn = (input) => ({
      runUuid: input.runUuid ?? 'fake-uuid',
      phase: 'implement',
      kind: 'missing_artifact',
      message: 'MISSING ARTIFACT design.md',
      exitCode: input.exitCode,
      canRetry: false,
      suggestedAction: 'Inspect the phase prompt and stdout.',
      artifacts: input.artifacts ?? [],
      detectedAt: input.detectedAt ?? new Date(),
    });
    const { factory, dirs } = fakeDirectoryFactory({
      combinedLogContent: 'orchestrator_fail: MISSING ARTIFACT design.md',
    });
    const { fn: bash } = fakeBash({ exitCode: 1 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: classifierThatDetectsMissingArtifact,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    const out = await usecase.execute({ issueNumber: 9 });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(1);
    const patch = repo.finalPatch(out.uuid);
    expect(patch.failureReason).toBe('MISSING ARTIFACT design.md');
    expect(failureRepo.records).toHaveLength(1);
    expect(failureRepo.records[0]!.kind).toBe('missing_artifact');
    expect(dirs[0]!.failureWrites).toHaveLength(1);
    expect(dirs[0]!.failureWrites[0]!.kind).toBe('missing_artifact');
  });

  it('does not create failure.json on passing runs', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory, dirs } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash({ exitCode: 0 });
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    await usecase.execute({ issueNumber: 11 });
    expect(failureRepo.records).toHaveLength(0);
    expect(dirs[0]!.failureWrites).toHaveLength(0);
  });

  it('does not call classifier when runBashScript throws', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory, dirs } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash(new Error('spawn EACCES'));
    let classifierCalled = false;
    const trackingClassifier: ClassifyExitFn = (input) => {
      classifierCalled = true;
      return fakeClassifyExit(input);
    };
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: trackingClassifier,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      now: fixedNow,
    });
    await expect(usecase.execute({ issueNumber: 8 })).rejects.toThrow(/spawn EACCES/);
    expect(classifierCalled).toBe(false);
    expect(failureRepo.records).toHaveLength(0);
    expect(dirs[0]!.failureWrites).toHaveLength(0);
  });
});
