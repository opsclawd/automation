import { describe, it, expect } from 'vitest';
import { CreatePrHandler } from '../create-pr.js';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

async function buildContext(ctxOverrides?: Partial<PhaseHandlerContext>) {
  const artifacts = new FakeArtifactStore();
  const runUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  await artifacts.write({
    runId: runUuid,
    relativePath: 'validation.result',
    contents: 'passed\n',
  });
  await artifacts.write({
    runId: runUuid,
    relativePath: 'validation.headsha',
    contents: '0123456789abcdef0123456789abcdef01234567\n',
  });
  await artifacts.write({
    runId: runUuid,
    relativePath: 'implementation-log.md',
    contents: '# Implementation Log\nSummary of work\n',
  });

  const github = new FakeGitHubPort();
  github.issues.set('acme/widgets/1273', {
    number: 1273,
    title: 'Fix issue 1273',
    body: '',
    labels: ['ai:in-progress'],
  });

  const git = new FakeGitPort();
  const headSha = '0123456789abcdef0123456789abcdef01234567';
  git.headByCwd.set('/tmp/wt', headSha);

  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'run-1',
    runUuid,
    repoFullName: 'acme/widgets',
    issueNumber: 1273,
    cwd: '/tmp/wt',
    artifacts,
    github,
    git,
    agent: { invoke: () => Promise.reject(new Error('no agent')) } as never,
    events: {
      publish: (_u: string, e: OrchestratorEvent) => events.push(e),
      subscribe: () => () => {},
    },
    now: () => new Date('2026-09-23T11:00:00Z'),
    startCommitSha: headSha,
    ...ctxOverrides,
  } as unknown as PhaseHandlerContext;

  return { artifacts, github, git, events, ctx, headSha };
}

const handler = new CreatePrHandler({ headBranch: () => 'feat/issue-1273' });

describe('CreatePrHandler — Candidate Validation Governance Guard (Boundary 2)', () => {
  it('blocks PR creation and halts in needs_human_review when committed tree contains fabricated [x] GO report', async () => {
    const { ctx, git, headSha, events } = await buildContext();

    const reportPath = 'docs/phase-3-candidate-validation-report.md';
    git.committedFilesByCommit.set(headSha, [reportPath]);
    git.fileContentResults.set(
      `${headSha}:${reportPath}`,
      '# Candidate Report\n- [x] GO\nReviewing Authority (Sign-off): opsclawd (operator)\n',
    );

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.canRetry).toBe(false);
      expect(result.failure.message).toContain('candidate-validation governance violation');
    }

    expect(git.pushes).toHaveLength(0);
    expect(events.some((e) => e.type === 'create_pr.governance_violation')).toBe(true);
    expect(events.some((e) => e.type === 'create_pr.needs_human_review')).toBe(true);
  });

  it('blocks PR creation when committed tree contains report asserting measured claims and 100% metrics', async () => {
    const { ctx, git, headSha } = await buildContext();

    const reportPath = 'docs/phase-3-candidate-validation-report.md';
    git.committedFilesByCommit.set(headSha, [reportPath]);
    git.fileContentResults.set(
      `${headSha}:${reportPath}`,
      '# Candidate Report\nScenarios Passed: 3/3\nRequirement Coverage: 100%\nReal-Provider Execution: Completed\n',
    );

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.canRetry).toBe(false);
    }
    expect(git.pushes).toHaveLength(0);
  });

  it('allows PR creation when committed tree contains blank template and code only', async () => {
    const { ctx, git, headSha } = await buildContext();

    const templatePath = 'docs/phase-3-report-template.md';
    git.committedFilesByCommit.set(headSha, [templatePath, 'src/harness.ts']);
    git.fileContentResults.set(
      `${headSha}:${templatePath}`,
      '# Report Template\n- [ ] GO\n- [ ] NO-GO\nCandidate SHA: <pinned-candidate-sha>\n',
    );
    git.fileContentResults.set(`${headSha}:src/harness.ts`, 'export class ValidationHarness {}\n');

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.pushes).toHaveLength(1);
  });

  it('blocks PR creation when live HEAD moves during verification (Witness-6)', async () => {
    const { ctx, git, headSha } = await buildContext();

    // Live head is headSha during initial checks, but moves during Stage 3c verification
    let headCalls = 0;
    git.headCommitSha = async () => {
      headCalls++;
      if (headCalls > 1) {
        return 'advanced-head-commit-9999999999999999999';
      }
      return headSha;
    };

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain('HEAD moved during verification');
    }
    expect(git.pushes).toHaveLength(0);
  });

  it('fails closed when HEAD does not resolve to a commit object', async () => {
    const { ctx, git } = await buildContext();

    git.resolveCommitShaResults.set('/tmp/wt:HEAD', undefined);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain(
        'HEAD does not resolve to an immutable commit object',
      );
    }
    expect(git.pushes).toHaveLength(0);
  });

  it('blocks PR creation when uncommitted worktree contains candidate report with fabricated claims', async () => {
    const { ctx, git } = await buildContext();

    const reportPath = 'docs/phase-3-candidate-validation-report.md';
    git.worktreeFilesByCwd.set('/tmp/wt', [reportPath]);
    git.worktreeFileContents.set(`/tmp/wt:${reportPath}`, '# Report\n- [x] GO\n');

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(git.pushes).toHaveLength(0);
  });

  it('allows PR creation when baseBranch contains pre-existing operator-authored candidate report unchanged in branch', async () => {
    const { ctx, git, headSha } = await buildContext();

    const historicalReportPath = 'docs/phase-1-candidate-validation-report.md';
    const historicalContent =
      '# Candidate Validation Report - Phase 1\n- [x] GO\nReviewing Authority (Sign-off): opsclawd (operator)\n';

    // Base branch (main) contains the historical report
    const baseBranch = 'main';
    git.fileContentResults.set(`${baseBranch}:${historicalReportPath}`, historicalContent);

    // headSha contains the historical report (identical) plus a blank template and feature code
    const templatePath = 'docs/phase-3-report-template.md';
    git.committedFilesByCommit.set(headSha, [historicalReportPath, templatePath, 'src/feature.ts']);
    git.fileContentResults.set(`${headSha}:${historicalReportPath}`, historicalContent);
    git.fileContentResults.set(
      `${headSha}:${templatePath}`,
      '# Report Template\n- [ ] GO\n- [ ] NO-GO\nCandidate SHA: <pinned-candidate-sha>\n',
    );
    git.fileContentResults.set(`${headSha}:src/feature.ts`, 'export const feature = true;\n');

    // Tracked worktree file is identical to headSha
    git.worktreeFilesByCwd.set('/tmp/wt', [historicalReportPath]);
    git.worktreeFileContents.set(`/tmp/wt:${historicalReportPath}`, historicalContent);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(git.pushes).toHaveLength(1);
  });

  it('blocks PR creation when branch modifies a pre-existing candidate report relative to baseBranch', async () => {
    const { ctx, git, headSha } = await buildContext();

    const historicalReportPath = 'docs/phase-1-candidate-validation-report.md';
    const baseContent =
      '# Candidate Validation Report - Phase 1\n- [ ] GO\nReviewing Authority (Sign-off): <operator>\n';
    const modifiedContent =
      '# Candidate Validation Report - Phase 1\n- [x] GO\nReviewing Authority (Sign-off): opsclawd (operator)\n';

    const baseBranch = 'main';
    git.fileContentResults.set(`${baseBranch}:${historicalReportPath}`, baseContent);

    git.committedFilesByCommit.set(headSha, [historicalReportPath]);
    git.fileContentResults.set(`${headSha}:${historicalReportPath}`, modifiedContent);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(git.pushes).toHaveLength(0);
  });

  it('blocks PR creation when worktree modifies a candidate report relative to headSha', async () => {
    const { ctx, git, headSha } = await buildContext();

    const historicalReportPath = 'docs/phase-1-candidate-validation-report.md';
    const cleanContent =
      '# Candidate Validation Report - Phase 1\n- [ ] GO\nReviewing Authority (Sign-off): <operator>\n';
    const modifiedWorktreeContent =
      '# Candidate Validation Report - Phase 1\n- [x] GO\nReviewing Authority (Sign-off): opsclawd (operator)\n';

    const baseBranch = 'main';
    git.fileContentResults.set(`${baseBranch}:${historicalReportPath}`, cleanContent);
    git.committedFilesByCommit.set(headSha, [historicalReportPath]);
    git.fileContentResults.set(`${headSha}:${historicalReportPath}`, cleanContent);

    git.worktreeFilesByCwd.set('/tmp/wt', [historicalReportPath]);
    git.worktreeFileContents.set(`/tmp/wt:${historicalReportPath}`, modifiedWorktreeContent);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    expect(git.pushes).toHaveLength(0);
  });
});
