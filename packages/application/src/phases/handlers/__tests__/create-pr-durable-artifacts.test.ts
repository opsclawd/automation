import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreatePrHandler } from '../create-pr.js';
import { FakeArtifactStore, FakeGitHubPort, FakeGitPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';

class CleanupGitPort extends FakeGitPort {
  override async cleanOrchestratorArtifacts(cwd: string, _baseBranch?: string): Promise<void> {
    await rmSync(join(cwd, 'implementation-log.md'), { force: true });
    await rmSync(join(cwd, 'task-manifest.json'), { force: true });
    await rmSync(join(cwd, 'plan.md'), { force: true });
    await rmSync(join(cwd, 'validation.result'), { force: true });
    await rmSync(join(cwd, 'pr-summary.md'), { force: true });
    await rmSync(join(cwd, 'pr-url.txt'), { force: true });
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'create-pr-durable-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

async function build() {
  const cwd = makeTempDir();
  const artifacts = new FakeArtifactStore();
  const github = new FakeGitHubPort();
  github.issues.set('acme/widgets/7', {
    number: 7,
    title: 'Fix widget workflow',
    body: '',
    labels: [],
  });

  const git = new CleanupGitPort();
  git.headByCwd.set(cwd, 'base-sha');

  const ctx = {
    runId: 'issue-7-run',
    runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd,
    artifacts,
    github,
    git,
    agent: { invoke: vi.fn() } as never,
    events: {
      publish: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
    },
    now: () => new Date('2026-06-22T12:00:00.000Z'),
    baseBranch: 'main',
    startCommitSha: 'base-sha',
  } as unknown as PhaseHandlerContext;

  await artifacts.write({
    runId: ctx.runUuid,
    relativePath: 'validation.result',
    contents: 'passed\n',
  });
  await artifacts.write({
    runId: ctx.runUuid,
    relativePath: 'implementation-log.md',
    contents: '# Implementation Log\nDurable implementation summary.\n\nMore details.\n',
  });
  await artifacts.write({
    runId: ctx.runUuid,
    relativePath: 'task-manifest.json',
    contents: JSON.stringify({
      version: 1,
      tasks: [
        { n: 1, title: 'Add durable artifact storage' },
        { n: 2, title: 'Add resume coverage' },
      ],
    }),
  });
  await artifacts.write({
    runId: ctx.runUuid,
    relativePath: 'plan.md',
    contents: '# Plan\n\n## Task 1: Add storage\n## Task 2: Add coverage\n',
  });

  return { artifacts, github, git, ctx };
}

const HANDLER = new CreatePrHandler({ headBranch: () => 'feat/issue-7' });

describe('CreatePrHandler durable artifacts', () => {
  it('assembles the PR summary from durable artifacts even after worktree cleanup', async () => {
    const { artifacts, github, git, ctx } = await build();
    const cleanupSpy = vi.spyOn(git, 'cleanOrchestratorArtifacts');

    const result = await HANDLER.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(cleanupSpy).toHaveBeenCalledWith(ctx.cwd, ctx.baseBranch ?? 'main');
    expect(git.pushes).toHaveLength(1);
    expect(github.createdPrInputs).toHaveLength(1);

    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('## Tasks');
    expect(summary).toContain('- Add durable artifact storage');
    expect(summary).toContain('- Add resume coverage');
    expect(summary).toContain('## Validation: passed');
    expect(summary).toContain('Durable implementation summary.');

    const url = await artifacts.read(ctx.runUuid, 'pr-url.txt');
    expect(url).toContain('https://example/pr/');

    const storedArtifacts = await artifacts.list(ctx.runUuid);
    expect(storedArtifacts.map((artifact) => artifact.relativePath)).toEqual(
      expect.arrayContaining([
        'pr-summary.md',
        'pr-url.txt',
        'validation.result',
        'implementation-log.md',
      ]),
    );
  });
});
