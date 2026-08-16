import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import type {
  ImplementStepLoopDeps,
  ImplementResult,
  ImplementStepOptions,
  TypecheckResult,
  StepLoopContext,
  SpecReviewResult,
  QualityReviewResult,
  FixResult,
} from '../types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import type { GitPort } from '../../ports/git-port.js';

function makeFakeGitPort(opts: {
  headSha?: string | string[];
  statusOutput?: string | string[];
  diffOutput?: string | string[];
  headShaThrows?: boolean;
  statusThrows?: boolean;
}): GitPort {
  let headShaIndex = 0;
  const headShas = opts.headSha
    ? Array.isArray(opts.headSha)
      ? opts.headSha
      : [opts.headSha]
    : ['sha-1'];
  let statusIndex = 0;
  const statuses = opts.statusOutput
    ? Array.isArray(opts.statusOutput)
      ? opts.statusOutput
      : [opts.statusOutput]
    : [''];
  let diffIndex = 0;
  const diffs = opts.diffOutput
    ? Array.isArray(opts.diffOutput)
      ? opts.diffOutput
      : [opts.diffOutput]
    : [''];

  return {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () => {
      if (opts.headShaThrows) throw new Error('rev-parse failed');
      const val = headShas[headShaIndex];
      if (headShaIndex < headShas.length - 1) {
        headShaIndex++;
      }
      return val;
    },
    resetHard: async () => undefined,
    diff: async () => {
      const val = diffs[diffIndex];
      if (diffIndex < diffs.length - 1) {
        diffIndex++;
      }
      return val;
    },
    diffStat: async () => '',
    addAll: async () => undefined,
    commit: async () => 'sha-new',
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () => {
      if (opts.statusThrows) throw new Error('status failed');
      const val = statuses[statusIndex];
      if (statusIndex < statuses.length - 1) {
        statusIndex++;
      }
      return val;
    },
    resetWorktreeIfClean: async () => undefined,
  };
}

function collectEvents() {
  const events: Array<{
    type: string;
    level: string;
    message: string;
    metadata: Record<string, unknown>;
  }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, level: e.level, message: e.message, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'owner/repo',
    cwd: '/wt',
    stepIndex: 1,
    stepTitle: 'Add login page',
    maxIterations: 3,
    manifest: { tasks: [] },
    planMd: '',
  };
}

function createHarness(
  overrides: Partial<ImplementStepLoopDeps> & {
    eventsList?: Array<{
      type: string;
      level: string;
      message: string;
      metadata: Record<string, unknown>;
    }>;
  } = {},
) {
  const { events, bus } = collectEvents();
  const eventsList = overrides.eventsList ?? events;

  let n = 0;
  const deps: ImplementStepLoopDeps = {
    runImplement: async (
      _ctx: StepLoopContext,
      _opts?: ImplementStepOptions,
    ): Promise<ImplementResult> => ({
      invocationId: `impl-${++n}`,
      agentOutcome: 'success',
    }),
    runTypecheck: async (): Promise<TypecheckResult> => ({
      outcome: 'pass',
      output: '',
    }),
    runSpecReview: async (): Promise<SpecReviewResult> => ({
      invocationId: 'spec-1',
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runQualityReview: async (): Promise<QualityReviewResult> => ({
      invocationId: 'qual-1',
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (): Promise<FixResult> => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    implementProfile: AgentProfileName('test-profile'),
    fixProfile: AgentProfileName('fix-profile'),
    loops: new FakeLoopRepository(),
    events: {
      publish: (runUuid, e) => {
        bus.publish(runUuid, e);
        if (overrides.events?.publish) {
          overrides.events.publish(runUuid, e);
        }
      },
      subscribe: bus.subscribe,
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    idFactory: () => 'loop-1',
    ...overrides,
  };

  const loop = new ImplementStepLoop(deps);
  return { loop, deps, events: eventsList };
}

describe('ImplementStepLoop typecheck retry no-op detection', () => {
  it('short-circuits a successful retry when HEAD and diff are unchanged', async () => {
    let typecheckCalls = 0;
    let implementCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-before', 'sha-before'],
      diffOutput: ['', ''],
    });

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        return { outcome: 'fail', output: 'error TS2322: Type error' };
      },
      runImplement: async (_ctx, _opts) => {
        implementCalls++;
        if (implementCalls === 1) {
          return { invocationId: 'impl-initial', agentOutcome: 'success' };
        }
        return {
          invocationId: 'impl-retry',
          agentOutcome: 'success',
          transcriptExcerpt: 'Validation results: tests passed\nStatus: DONE',
        };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('failed');
    expect(typecheckCalls).toBe(1);
    expect(implementCalls).toBe(2);
    expect(
      events.find((event) => event.type === 'step.typecheck.retry_no_op')?.metadata,
    ).toMatchObject({
      index: 1,
      attempt: 1,
      invocationId: 'impl-retry',
      transcriptExcerpt: 'Validation results: tests passed\nStatus: DONE',
      retryProducedNoChanges: true,
    });
    expect(events.find((event) => event.type === 'step.typecheck.stalled')?.metadata).toMatchObject(
      { retryProducedNoChanges: true },
    );
    expect(events.find((event) => event.type === 'step.typecheck.failed')?.metadata).toMatchObject({
      retryProducedNoChanges: true,
    });
  });

  it('re-runs typecheck when the retry advances HEAD', async () => {
    let typecheckCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-1', 'sha-2', 'sha-2', 'sha-2'],
      diffOutput: ['', '', '', ''],
    });

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        if (typecheckCalls === 1) {
          return { outcome: 'fail', output: 'error TS2322: Type error' };
        }
        return { outcome: 'pass', output: '' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('re-runs typecheck when the retry changes working-tree diff', async () => {
    let typecheckCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-1', 'sha-1', 'sha-1', 'sha-1'],
      diffOutput: [
        '',
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
      ],
    });

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        if (typecheckCalls === 1) {
          return { outcome: 'fail', output: 'error TS2322: Type error' };
        }
        return { outcome: 'pass', output: '' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('re-runs typecheck when file is already dirty but content changes during retry', async () => {
    let typecheckCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-1', 'sha-1', 'sha-1', 'sha-1'],
      diffOutput: [
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old-content\n+fixed-content',
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old-content\n+different-content',
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old-content\n+different-content',
        '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old-content\n+different-content',
      ],
    });

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        if (typecheckCalls === 1) {
          return { outcome: 'fail', output: 'error TS2322: Type error' };
        }
        return { outcome: 'pass', output: '' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('preserves retry behavior when the git dependency is absent', async () => {
    let typecheckCalls = 0;

    const { loop, events } = createHarness({
      git: undefined,
      runTypecheck: async () => {
        typecheckCalls++;
        if (typecheckCalls === 1) {
          return { outcome: 'fail', output: 'error TS2322: Type error' };
        }
        return { outcome: 'pass', output: '' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(2);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('preserves retry behavior when git snapshot capture fails', async () => {
    let typecheckCalls = 0;

    const git = makeFakeGitPort({});
    let headCallCount = 0;
    git.headCommitSha = async () => {
      headCallCount++;
      if (headCallCount <= 2) {
        throw new Error('rev-parse failed');
      }
      return 'sha-1';
    };

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        if (typecheckCalls === 1) {
          return { outcome: 'fail', output: 'error TS2322: Type error' };
        }
        return { outcome: 'pass', output: '' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('keeps fingerprint stall detection for a retry that produced changes', async () => {
    let typecheckCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-1', 'sha-2', 'sha-3'],
      diffOutput: ['', '', ''],
    });

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        return { outcome: 'fail', output: 'error TS2322: Same error' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('failed');
    expect(typecheckCalls).toBe(2);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();

    const stalledEvent = events.find((event) => event.type === 'step.typecheck.stalled');
    const failedEvent = events.find((event) => event.type === 'step.typecheck.failed');

    expect(stalledEvent?.metadata).toMatchObject({ retryProducedNoChanges: false });
    expect(failedEvent?.metadata).toMatchObject({ retryProducedNoChanges: false });
  });

  it('preserves immediate failure when the retry agent is unsuccessful', async () => {
    let typecheckCalls = 0;
    let headCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-1', 'sha-2'],
    });

    const originalHeadCommitSha = git.headCommitSha;
    git.headCommitSha = async (cwd) => {
      headCalls++;
      return originalHeadCommitSha(cwd);
    };

    let implementCalls = 0;
    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => {
        typecheckCalls++;
        return { outcome: 'fail', output: 'error TS2322: Type error' };
      },
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 1) {
          return { invocationId: 'impl-1', agentOutcome: 'success' };
        }
        return { invocationId: 'impl-2', agentOutcome: 'failed' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('failed');
    expect(typecheckCalls).toBe(1);
    expect(headCalls).toBe(1);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('caps no-op transcript evidence and attributes it to the final retry invocation', async () => {
    let implementCalls = 0;

    const git = makeFakeGitPort({
      headSha: ['sha-before', 'sha-before'],
      diffOutput: ['', ''],
    });

    const longExcerpt = 'A'.repeat(2500);

    const { loop, events } = createHarness({
      git,
      runTypecheck: async () => ({ outcome: 'fail', output: 'error TS2322: Type error' }),
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 1) {
          return {
            invocationId: 'impl-initial',
            agentOutcome: 'success',
            transcriptExcerpt: 'initial',
          };
        }
        return {
          invocationId: 'impl-retry-final',
          agentOutcome: 'success',
          transcriptExcerpt: longExcerpt,
        };
      },
    });

    await loop.execute(baseInput());

    const noOpEvent = events.find((event) => event.type === 'step.typecheck.retry_no_op');
    expect(noOpEvent).toBeDefined();
    expect(noOpEvent?.metadata.invocationId).toBe('impl-retry-final');
    expect((noOpEvent?.metadata.transcriptExcerpt as string).length).toBe(2000);
  });

  it('detects an edit to an already-untracked source file as retry progress', async () => {
    let typecheckCalls = 0;
    let implementCalls = 0;
    let content = 'before correction';

    const git = makeFakeGitPort({
      headSha: 'sha-1',
      diffOutput: '',
      statusOutput: '?? src/new-file.ts',
    });

    const { loop, events } = createHarness({
      git,
      readWorktreeFile: async (_cwd, relativePath) =>
        relativePath === 'src/new-file.ts' ? content : undefined,
      runTypecheck: async () => {
        typecheckCalls++;
        return typecheckCalls === 1
          ? { outcome: 'fail', output: 'error TS2322: Type error' }
          : { outcome: 'pass', output: '' };
      },
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 2) content = 'after correction';
        return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('detects creation of a new untracked source file as retry progress', async () => {
    let typecheckCalls = 0;
    let implementCalls = 0;
    let content: string | undefined;
    const git = makeFakeGitPort({
      headSha: 'sha-1',
      diffOutput: '',
      statusOutput: ['', '?? src/created.ts'],
    });

    const { loop, events } = createHarness({
      git,
      readWorktreeFile: async (_cwd, relativePath) =>
        relativePath === 'src/created.ts' ? content : undefined,
      runTypecheck: async () => {
        typecheckCalls++;
        return typecheckCalls === 1
          ? { outcome: 'fail', output: 'error TS2322: Type error' }
          : { outcome: 'pass', output: '' };
      },
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 2) content = 'new source';
        return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('treats a disappearing untracked source file as changed without throwing', async () => {
    let typecheckCalls = 0;
    let implementCalls = 0;
    let content: string | undefined = 'temporary source';
    const git = makeFakeGitPort({
      headSha: 'sha-1',
      diffOutput: '',
      statusOutput: '?? src/transient.ts',
    });

    const { loop, events } = createHarness({
      git,
      readWorktreeFile: async (_cwd, relativePath) =>
        relativePath === 'src/transient.ts' ? content : undefined,
      runTypecheck: async () => {
        typecheckCalls++;
        return typecheckCalls === 1
          ? { outcome: 'fail', output: 'error TS2322: Type error' }
          : { outcome: 'pass', output: '' };
      },
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 2) content = undefined;
        return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });

  it('ignores content edits to filtered orchestrator artifacts when classifying retry progress', async () => {
    let implementCalls = 0;
    let readCalls = 0;
    let content = 'before';
    const git = makeFakeGitPort({
      headSha: 'sha-1',
      diffOutput: '',
      statusOutput: '?? implementation-log.md',
    });

    const { loop, events } = createHarness({
      git,
      readWorktreeFile: async () => {
        readCalls++;
        return content;
      },
      runTypecheck: async () => ({ outcome: 'fail', output: 'error TS2322: Type error' }),
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 2) content = 'after';
        return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('failed');
    expect(readCalls).toBe(0);
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeDefined();
  });

  it('bounds untracked files digest inspection to at most 10 paths', async () => {
    const readPaths: string[] = [];
    const files = Array.from(
      { length: 15 },
      (_, i) => `src/file-${String(i + 1).padStart(2, '0')}.ts`,
    );
    const statusOutput = files.map((f) => `?? ${f}`).join('\n');

    let typecheckCalls = 0;
    let implementCalls = 0;
    let content = 'initial content';
    const git = makeFakeGitPort({
      headSha: 'sha-1',
      diffOutput: '',
      statusOutput,
    });

    const { loop } = createHarness({
      git,
      readWorktreeFile: async (_cwd, relativePath) => {
        readPaths.push(relativePath);
        return relativePath === files[0] ? content : 'static content';
      },
      runTypecheck: async () => {
        typecheckCalls++;
        return typecheckCalls === 1
          ? { outcome: 'fail', output: 'error TS2322: Type error' }
          : { outcome: 'pass', output: '' };
      },
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 2) {
          content = 'updated content';
        }
        return {
          invocationId: `impl-${implementCalls}`,
          agentOutcome: 'success',
        };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    // Unique paths inspected should be bounded by MAX_UNTRACKED_DIGEST_PATHS (10)
    const uniqueReadPaths = [...new Set(readPaths)];
    expect(uniqueReadPaths.length).toBe(10);
    expect(uniqueReadPaths).toEqual(files.slice(0, 10));
  });

  it('correctly unquotes quoted untracked paths with spaces', async () => {
    let typecheckCalls = 0;
    let implementCalls = 0;
    let content = 'initial space content';
    const readPaths: string[] = [];

    const git = makeFakeGitPort({
      headSha: 'sha-1',
      diffOutput: '',
      statusOutput: '?? "src/file with spaces.ts"',
    });

    const { loop, events } = createHarness({
      git,
      readWorktreeFile: async (_cwd, relativePath) => {
        readPaths.push(relativePath);
        return relativePath === 'src/file with spaces.ts' ? content : undefined;
      },
      runTypecheck: async () => {
        typecheckCalls++;
        return typecheckCalls === 1
          ? { outcome: 'fail', output: 'error TS2322: Type error' }
          : { outcome: 'pass', output: '' };
      },
      runImplement: async () => {
        implementCalls++;
        if (implementCalls === 2) {
          content = 'modified space content';
        }
        return { invocationId: `impl-${implementCalls}`, agentOutcome: 'success' };
      },
    });

    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('success');
    expect(typecheckCalls).toBe(3);
    expect(readPaths).toContain('src/file with spaces.ts');
    expect(readPaths).not.toContain('"src/file with spaces.ts"');
    expect(events.find((event) => event.type === 'step.typecheck.retry_no_op')).toBeUndefined();
  });
});
