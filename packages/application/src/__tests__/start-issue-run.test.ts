import { describe, expect, it } from 'vitest';
import type { Failure, Run, ClassifyExitInput, RunStatus } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { StartIssueRun } from '../start-issue-run.js';
import type {
  ClassifyExitFn,
  EventBusPort,
  EventRepositoryPort,
  EventTailerFactory,
  FailureRepositoryPort,
  RunBashScriptFn,
  RunDirectoryFactory,
  RunDirectoryHandle,
  RunRepositoryPort,
  RunRepositoryUpdatePatch,
  RunRecord,
  TmpDirectoryFactory,
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
  findByUuid(_uuid: string): RunRecord | undefined {
    return undefined;
  }
  finalPatch(uuid: string): RunRepositoryUpdatePatch {
    const merged: RunRepositoryUpdatePatch = {};
    for (const u of this.updates) {
      if (u.uuid === uuid) Object.assign(merged, u.patch);
    }
    return merged;
  }
  findByIssueNumber(issueNumber: number): RunRecord | undefined {
    const inserted = this.inserted.find((r) => r.issueNumber === issueNumber);
    if (!inserted) return undefined;
    // Check if a terminal status was applied via update()
    let status = inserted.status;
    let completedAt: Date | undefined;
    let failureReason: string | undefined;
    for (const u of this.updates) {
      if (u.patch.status) status = u.patch.status;
      if (u.patch.completedAt) completedAt = u.patch.completedAt;
      if (u.patch.failureReason) failureReason = u.patch.failureReason;
    }
    return {
      uuid: inserted.uuid,
      displayId: inserted.displayId,
      issueNumber: inserted.issueNumber,
      type: inserted.type,
      status,
      completedPhases: inserted.completedPhases,
      startedAt: inserted.startedAt,
      ...(completedAt ? { completedAt } : {}),
      ...(failureReason ? { failureReason } : {}),
    };
  }
  findActiveRuns(): RunRecord[] {
    return [];
  }
  updateStatusByIssueNumber(
    _issueNumber: number,
    _patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    return true;
  }
  updateStatusByUuid(
    _uuid: string,
    _patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    return true;
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

const fakeClassifyExit: ClassifyExitFn = (input) => {
  const tail = input.combinedLogTail.trim();
  const message = tail
    ? tail
        .split('\n')
        .filter((l) => l.trim())
        .slice(-3)
        .join('\n')
        .trim()
    : `script exited with code ${input.exitCode}`;
  return {
    kind: 'command_failed',
    message,
    exitCode: input.exitCode,
    canRetry: false,
    suggestedAction: 'Inspect combined.log and stderr.log for the cause.',
    artifacts: input.artifacts ?? [],
    detectedAt: input.detectedAt ?? new Date(),
    runUuid: input.runUuid,
  };
};

interface FakeDir extends RunDirectoryHandle {
  writes: Run[];
  failureWrites: Failure[];
  combinedLogContent: string;
}

function fakeDirectoryFactory(opts?: {
  failWrite?: boolean;
  failCreate?: boolean;
  failWriteFailureJson?: boolean;
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
        eventsJsonlPath: `/fake/${run.displayId}/events.jsonl`,
      },
      writes: [],
      failureWrites: [],
      combinedLogContent: opts?.combinedLogContent ?? '',
      writeRunJson(r) {
        if (opts?.failWrite) throw new Error('disk full');
        this.writes.push(r);
      },
      writeFailureJson(f) {
        if (opts?.failWriteFailureJson || opts?.failWrite) throw new Error('disk full');
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

const fakeTmpDir: TmpDirectoryFactory = (input) => ({
  tmpDir: `${input.baseTmpDir}/${input.runId}`,
  remove() {},
});

const defaultEventDeps = () => ({
  eventRepository: new FakeEventRepository(),
  eventBus: new FakeEventBus(),
  createEventTailer: (() => ({
    start: async () => {},
    drainAndStop: async () => {},
    stop: async () => {},
  })) as EventTailerFactory,
  baseTmpDir: '/fake/.ai-tmp',
  tmpDirectoryFactory: fakeTmpDir,
});

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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
      now: fixedNow,
      logger: { error: (m) => errors.push(m) },
    });
    const out = await usecase.execute({ issueNumber: 3 });
    expect(out.status).toBe('passed');
    expect(errors[0]).toMatch(/Failed to write run\.json/);
    const patch = repo.finalPatch(out.uuid);
    expect(patch.failureReason).toMatch(/run\.json write failed/);
  });

  it('marks run failed when runBashScript throws without calling classifier', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory, dirs } = fakeDirectoryFactory({
      combinedLogContent: '[build failed]\nsome earlier sentinel in log',
    });
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
      ...defaultEventDeps(),
      now: fixedNow,
    });
    await expect(usecase.execute({ issueNumber: 8 })).rejects.toThrow(/spawn EACCES/);
    expect(classifierCalled).toBe(false);
    const patch = repo.finalPatch(repo.inserted[0]!.uuid);
    expect(patch.status).toBe('failed');
    expect(patch.failureReason).toBe('spawn EACCES');
    expect(patch.exitCode).toBe(-1);
    expect(dirs[0]!.writes).toHaveLength(1);
    expect(failureRepo.records).toHaveLength(1);
    expect(failureRepo.records[0]!.kind).toBe('command_failed');
    expect(failureRepo.records[0]!.message).toBe('spawn EACCES');
    expect(dirs[0]!.failureWrites).toHaveLength(1);
    expect(dirs[0]!.failureWrites[0]!.message).toBe('spawn EACCES');
  });

  it('classifies failure and persists failure.json on non-zero exit', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const classifierThatDetectsMissingArtifact: ClassifyExitFn = (input) => ({
      runUuid: input.runUuid,
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
      ...defaultEventDeps(),
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
      ...defaultEventDeps(),
      now: fixedNow,
    });
    await usecase.execute({ issueNumber: 11 });
    expect(failureRepo.records).toHaveLength(0);
    expect(dirs[0]!.failureWrites).toHaveLength(0);
  });

  it('continues failure path when writeFailureJson throws', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory({ failWriteFailureJson: true });
    const { fn: bash } = fakeBash({ exitCode: 1 });
    const errors: string[] = [];
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      ...defaultEventDeps(),
      now: fixedNow,
      logger: { error: (m) => errors.push(m) },
    });
    const out = await usecase.execute({ issueNumber: 4 });
    expect(out.status).toBe('failed');
    expect(failureRepo.records).toHaveLength(1);
    const patch = repo.finalPatch(out.uuid);
    expect(patch.status).toBe('failed');
    expect(patch.failureReason).toBeDefined();
    expect(errors[0]).toMatch(/Failed to write failure\.json/);
  });

  it('passes AI_RUN_EVENTS_FILE and AI_RUN_DISPLAY_ID to the bash script env', async () => {
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
      ...defaultEventDeps(),
      now: fixedNow,
    });
    const result = await usecase.execute({ issueNumber: 7 });
    expect(calls[0]!.env.AI_RUN_EVENTS_FILE).toMatch(/events\.jsonl$/);
    expect(calls[0]!.env.AI_RUN_DISPLAY_ID).toBe(result.displayId);
  });

  it('continues failure path when failureRepository.insert throws', async () => {
    const repo = new FakeRunRepository();
    const throwingFailureRepo: FailureRepositoryPort = {
      insert() {
        throw new Error('SQLITE_CONSTRAINT: unique');
      },
      findLatestByRun() {
        return undefined;
      },
    };
    const { factory, dirs } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash({ exitCode: 1 });
    const errors: string[] = [];
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: throwingFailureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      ...defaultEventDeps(),
      now: fixedNow,
      logger: { error: (m) => errors.push(m) },
    });
    const out = await usecase.execute({ issueNumber: 5 });
    expect(out.status).toBe('failed');
    const patch = repo.finalPatch(out.uuid);
    expect(patch.status).toBe('failed');
    expect(patch.failureReason).toBeDefined();
    expect(errors.some((e) => /Failed to insert failure record/.test(e))).toBe(true);
    expect(dirs[0]!.failureWrites).toHaveLength(1);
  });

  it('injects TMPDIR and SQLITE_TMPDIR into the run env dict', async () => {
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
      baseTmpDir: '/fake/.ai-tmp',
      tmpDirectoryFactory: fakeTmpDir,
      ...defaultEventDeps(),
      now: fixedNow,
    });
    const out = await usecase.execute({ issueNumber: 20 });
    const env = calls[0]!.env;
    expect(env.TMPDIR).toBe(`/fake/.ai-tmp/${out.uuid}`);
    expect(env.SQLITE_TMPDIR).toBe(`/fake/.ai-tmp/${out.uuid}`);
  });
});

class FakeEventRepository implements EventRepositoryPort {
  events: Array<{ runUuid: string; type: string; timestamp: Date }> = [];
  insert(event: { runUuid: string; type: string; timestamp: Date; [k: string]: unknown }): number {
    this.events.push({ runUuid: event.runUuid, type: event.type, timestamp: event.timestamp });
    return this.events.length;
  }
  listByRunSince(): Array<{ id: number; runUuid: string; type: string; [k: string]: unknown }> {
    return [];
  }
}

class FakeEventBus implements EventBusPort {
  published: Array<{ runUuid: string; type: string }> = [];
  subscribe(): () => void {
    return () => {};
  }
  publish(runUuid: string, event: OrchestratorEvent): void {
    this.published.push({ runUuid, type: event.type });
  }
}

describe('StartIssueRun event ingestion', () => {
  it('tails events.jsonl and inserts events into EventRepository + EventBus during run', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash({ exitCode: 0 });
    const eventRepo = new FakeEventRepository();
    const eventBus = new FakeEventBus();

    let tailerOnEvent: ((e: OrchestratorEvent) => void) | null = null;
    const fakeTailerFactory: EventTailerFactory = (input) => {
      tailerOnEvent = input.onEvent;
      return {
        start: async () => {},
        drainAndStop: async () => {},
        stop: async () => {},
      };
    };

    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      eventRepository: eventRepo,
      eventBus: eventBus,
      createEventTailer: fakeTailerFactory,
      baseTmpDir: '/fake/.ai-tmp',
      tmpDirectoryFactory: fakeTmpDir,
      now: fixedNow,
    });

    const out = await usecase.execute({ issueNumber: 12 });
    expect(tailerOnEvent).not.toBeNull();

    const event: OrchestratorEvent = {
      runId: out.displayId,
      level: 'info',
      type: 'run.started',
      message: 'run started',
      timestamp: fixedNow().toISOString(),
      metadata: {},
    };
    tailerOnEvent!(event);

    expect(eventRepo.events).toHaveLength(1);
    expect(eventRepo.events[0]!.runUuid).toBe(out.uuid);
    expect(eventRepo.events[0]!.type).toBe('run.started');
    expect(eventBus.published).toHaveLength(1);
    expect(eventBus.published[0]!.runUuid).toBe(out.uuid);
    expect(eventBus.published[0]!.type).toBe('run.started');
  });

  it('rejects events whose runId does not match the active run', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory();
    const { fn: bash } = fakeBash({ exitCode: 0 });
    const eventRepo = new FakeEventRepository();
    const eventBus = new FakeEventBus();

    let tailerOnEvent: ((e: OrchestratorEvent) => void) | null = null;
    const fakeTailerFactory: EventTailerFactory = (input) => {
      tailerOnEvent = input.onEvent;
      return {
        start: async () => {},
        drainAndStop: async () => {},
        stop: async () => {},
      };
    };

    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: fakeClassifyExit,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      eventRepository: eventRepo,
      eventBus: eventBus,
      createEventTailer: fakeTailerFactory,
      baseTmpDir: '/fake/.ai-tmp',
      tmpDirectoryFactory: fakeTmpDir,
      now: fixedNow,
    });

    await usecase.execute({ issueNumber: 13 });

    const mismatchEvent: OrchestratorEvent = {
      runId: 'wrong-display-id',
      level: 'info',
      type: 'run.started',
      message: 'stale event',
      timestamp: fixedNow().toISOString(),
      metadata: {},
    };
    tailerOnEvent!(mismatchEvent);

    expect(eventRepo.events).toHaveLength(0);
    expect(eventBus.published).toHaveLength(0);
  });

  it('passes collected events to classifyExit when events arrive during run', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory({ combinedLogContent: 'pnpm build failed' });
    const capturedInputs: ClassifyExitInput[] = [];
    const capturingClassifier: ClassifyExitFn = (input) => {
      capturedInputs.push(input);
      return {
        runUuid: input.runUuid,
        kind: 'command_failed',
        message: 'test',
        exitCode: input.exitCode,
        canRetry: false,
        suggestedAction: 'Inspect logs.',
        artifacts: input.artifacts ?? [],
        detectedAt: input.detectedAt ?? new Date(),
      };
    };

    let resolveBash: () => void;
    const bashPromise = new Promise<void>((resolve) => {
      resolveBash = resolve;
    });
    let bashResult: { exitCode: number; durationMs: number };
    const deferredBash: RunBashScriptFn = async () => {
      await bashPromise;
      return bashResult;
    };

    let tailerOnEvent: ((e: OrchestratorEvent) => void) | null = null;
    const fakeTailerFactory: EventTailerFactory = (input) => {
      tailerOnEvent = input.onEvent;
      return {
        start: async () => {},
        drainAndStop: async () => {},
        stop: async () => {},
      };
    };

    const eventRepo = new FakeEventRepository();
    const eventBus = new FakeEventBus();
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: capturingClassifier,
      runDirectoryFactory: factory,
      runBashScript: deferredBash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      eventRepository: eventRepo,
      eventBus: eventBus,
      createEventTailer: fakeTailerFactory,
      baseTmpDir: '/fake/.ai-tmp',
      tmpDirectoryFactory: fakeTmpDir,
      now: fixedNow,
    });

    bashResult = { exitCode: 1, durationMs: 100 };
    const executePromise = usecase.execute({ issueNumber: 42 });

    tailerOnEvent!({
      runId: 'issue-42-20260513-192300000',
      phase: 'validate',
      level: 'error',
      type: 'phase.failed',
      message: 'pnpm build failed',
      timestamp: '2026-05-13T19:23:00.000Z',
      metadata: { command: 'pnpm build', exitCode: 2 },
    });

    resolveBash!();
    await executePromise;

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]!.events).toBeDefined();
    expect(capturedInputs[0]!.events!.length).toBe(1);
    expect(capturedInputs[0]!.events![0]!.type).toBe('phase.failed');
    expect(capturedInputs[0]!.events![0]!.metadata).toEqual({ command: 'pnpm build', exitCode: 2 });
  });

  it('stops collecting events after classifyExit to avoid wasted work', async () => {
    const repo = new FakeRunRepository();
    const failureRepo = new FakeFailureRepository();
    const { factory } = fakeDirectoryFactory({ combinedLogContent: 'error output' });
    const { fn: bash } = fakeBash({ exitCode: 1 });
    const capturedInputs: ClassifyExitInput[] = [];
    const capturingClassifier: ClassifyExitFn = (input) => {
      capturedInputs.push(input);
      return {
        runUuid: input.runUuid,
        kind: 'command_failed',
        message: 'test',
        exitCode: input.exitCode,
        canRetry: false,
        suggestedAction: 'Inspect logs.',
        artifacts: input.artifacts ?? [],
        detectedAt: input.detectedAt ?? new Date(),
      };
    };

    let tailerOnEvent: ((e: OrchestratorEvent) => void) | null = null;
    const fakeTailerFactory: EventTailerFactory = (input) => {
      tailerOnEvent = input.onEvent;
      return {
        start: async () => {},
        drainAndStop: async () => {},
        stop: async () => {},
      };
    };

    const eventRepo = new FakeEventRepository();
    const eventBus = new FakeEventBus();
    const usecase = new StartIssueRun({
      runRepository: repo,
      failureRepository: failureRepo,
      classifyExit: capturingClassifier,
      runDirectoryFactory: factory,
      runBashScript: bash,
      runsDir: '/fake/.ai-runs',
      scriptPath: '/fake/script.sh',
      eventRepository: eventRepo,
      eventBus: eventBus,
      createEventTailer: fakeTailerFactory,
      baseTmpDir: '/fake/.ai-tmp',
      tmpDirectoryFactory: fakeTmpDir,
      now: fixedNow,
    });

    const out = await usecase.execute({ issueNumber: 55 });

    expect(capturedInputs).toHaveLength(1);
    const eventsBeforeDrain = capturedInputs[0]!.events ?? [];

    tailerOnEvent!({
      runId: out.displayId,
      phase: 'implement',
      level: 'error',
      type: 'phase.failed',
      message: 'late event after classification',
      timestamp: '2026-05-13T19:23:00.000Z',
      metadata: { reason: 'late' },
    });

    expect(capturedInputs[0]!.events).toEqual(eventsBeforeDrain);
  });
});
