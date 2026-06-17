import { describe, it, expect } from 'vitest';
import type { PhaseHandlerContext } from '../handler.js';
import { buildPhaseHandlerContext } from '../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

const base = {
  runId: 'run-1',
  runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  repoFullName: 'acme/widgets',
  issueNumber: 42,
  cwd: '/tmp/worktree',
  artifacts: {
    read: async () => '',
    write: async () => {},
    list: async () => [],
  },
  github: {
    getIssue: async () => ({
      number: 42,
      title: '',
      body: '',
      labels: [],
    }),
    createIssue: async () => ({ number: 43, url: '', labels: [] }),
    listIssueComments: async () => [],
    createIssueComment: async () => {},
    createPullRequest: async () => ({
      number: 1,
      url: '',
      headRef: '',
      baseRef: '',
      title: '',
      body: '',
    }),
    listPullRequests: async () => [],
    getPullRequest: async () => ({
      number: 1,
      htmlUrl: '',
      headRef: '',
      baseRef: '',
      labels: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      title: '',
      body: '',
    }),
    listReviewComments: async () => [],
    getRepositoryTopics: async () => [],
  },
  git: {
    createWorktree: async () => {},
    removeWorktree: async () => {},
    currentBranch: async () => 'main',
    headCommitSha: async () => '0'.repeat(40),
    headCommitShaOf: async () => '0'.repeat(40),
    resetHard: async () => {},
    diff: async () => '',
    commit: async () => '0'.repeat(40),
    push: async () => {},
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => {},
  },
  agent: {
    invoke: async () => ({
      runtime: 'opencode' as const,
      provider: 'anthropic',
      model: 'claude',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      contractViolations: [],
      outcome: 'success' as const,
    }),
  },
  events: {
    publish: (_u: string, _e: OrchestratorEvent) => {},
    subscribe: () => () => {},
  },
  now: () => new Date('2026-01-01T00:00:00Z'),
} satisfies Omit<
  PhaseHandlerContext,
  'promptsRoot' | 'startCommitSha' | 'expectedBranch' | 'resolveProfile' | 'idFactory'
>;

describe('buildPhaseHandlerContext', () => {
  it('returns a complete PhaseHandlerContext with all base fields', () => {
    const ctx = buildPhaseHandlerContext(base);
    expect(ctx.runId).toBe('run-1');
    expect(ctx.runUuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(ctx.repoFullName).toBe('acme/widgets');
    expect(ctx.issueNumber).toBe(42);
    expect(ctx.cwd).toBe('/tmp/worktree');
    expect(ctx.artifacts).toBeDefined();
    expect(ctx.github).toBeDefined();
    expect(ctx.git).toBeDefined();
    expect(ctx.agent).toBeDefined();
    expect(ctx.events).toBeDefined();
    expect(ctx.now()).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('sets optional fields to undefined when not provided', () => {
    const ctx = buildPhaseHandlerContext(base);
    expect(ctx.promptsRoot).toBeUndefined();
    expect(ctx.startCommitSha).toBeUndefined();
    expect(ctx.expectedBranch).toBeUndefined();
    expect(ctx.resolveProfile).toBeUndefined();
    expect(ctx.idFactory).toBeUndefined();
  });

  it('populates all optional fields when provided', () => {
    const resolveProfile = (_p: string) => 'opencode-frontier';
    const idFactory = () => 'custom-id';
    const ctx = buildPhaseHandlerContext(base, {
      promptsRoot: '/prompts',
      startCommitSha: 'abc123',
      expectedBranch: 'feature/foo',
      resolveProfile,
      idFactory,
    });
    expect(ctx.promptsRoot).toBe('/prompts');
    expect(ctx.startCommitSha).toBe('abc123');
    expect(ctx.expectedBranch).toBe('feature/foo');
    expect(ctx.resolveProfile).toBe(resolveProfile);
    expect(ctx.resolveProfile?.('any')).toBe('opencode-frontier');
    expect(ctx.idFactory).toBe(idFactory);
    expect(ctx.idFactory?.()).toBe('custom-id');
  });

  it('populates a subset of optional fields', () => {
    const ctx = buildPhaseHandlerContext(base, {
      promptsRoot: '/prompts',
      startCommitSha: 'abc123',
    });
    expect(ctx.promptsRoot).toBe('/prompts');
    expect(ctx.startCommitSha).toBe('abc123');
    expect(ctx.expectedBranch).toBeUndefined();
    expect(ctx.resolveProfile).toBeUndefined();
    expect(ctx.idFactory).toBeUndefined();
  });

  it('preserves base field values when opts are provided', () => {
    const ctx = buildPhaseHandlerContext(base, {
      promptsRoot: '/prompts',
    });
    expect(ctx.runId).toBe('run-1');
    expect(ctx.cwd).toBe('/tmp/worktree');
    expect(ctx.now()).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('does not mutate the base object', () => {
    const original = { ...base, now: base.now };
    buildPhaseHandlerContext(base, { promptsRoot: '/prompts' });
    expect(base).toEqual(original);
  });
});
