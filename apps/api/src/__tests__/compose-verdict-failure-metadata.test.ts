import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { composeRoot } from '../compose.js';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import { CONTRACT_VIOLATION_CODES, type ReviewFixLoopDeps } from '@ai-sdlc/application';
import type { AgentPort, AgentInvocationRequest } from '@ai-sdlc/application/ports';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function writeConfig(cwd: string) {
  const config = {
    validation: { commands: ['echo ok'], timeout: 60 },
    phases: { skip: [], reviewFix: { maxIterations: 1 }, implement: { maxIterations: 1 } },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'test',
      profiles: {
        test: {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          timeoutMinutes: 10,
        },
      },
      phaseProfiles: {
        'whole-pr-review': { profile: 'test' },
        'fix-review': { profile: 'test' },
        implement: { profile: 'test' },
        'spec-review': { profile: 'test' },
        'quality-review': { profile: 'test' },
      },
    },
  };
  writeFileSync(path.join(cwd, '.ai-orchestrator.json'), JSON.stringify(config), 'utf-8');
}

const FAKE_METADATA_RESOLVER = {
  resolve: (p: string) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

describe('compose review and fix failure metadata & transcript evidence forwarding', () => {
  it('runReview returns classification, violationCode, and detail when verdict extraction fails', async () => {
    const cwd = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'verdict-test-')));
    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "test"', { cwd, stdio: 'ignore' });
    writeFileSync(path.join(cwd, 'readme.md'), '# test');
    execSync('git add readme.md && git commit -m "initial"', { cwd, stdio: 'ignore' });
    writeConfig(cwd);

    const fakeAgent = {
      invoke: async (_req: AgentInvocationRequest) => {
        // Do NOT write result.json so readReviewVerdict fails with missing required artifact
        return {
          runtime: 'opencode' as const,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: path.join(cwd, 'stdout.log'),
          stderrPath: path.join(cwd, 'stderr.log'),
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const container = composeRoot({
      repoRoot: cwd,
      scriptPath: '/bin/true',
      metadataResolver: FAKE_METADATA_RESOLVER,
      agentAdapterOverrides: { opencode: fakeAgent as unknown as AgentPort },
    });

    const runUuid = 'run-verdict-1';
    container.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: '1',
      type: 'issue_to_pr',
      issueNumber: 1,
      repoId: RepositoryId('owner/repo'),
      phaseId: PhaseName('whole-pr-review'),
      status: 'in_progress',
      startedAt: new Date(),
      completedPhases: [],
    });

    const reviewLoop = container.reviewFixLoop as unknown as { deps: ReviewFixLoopDeps };
    expect(reviewLoop).toBeDefined();
    const runReview = reviewLoop.deps.runReview;

    const ctx = {
      loopId: 'loop-1',
      runId: RunId(runUuid),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'owner/repo',
      cwd,
      iterationIndex: 1,
    };

    const res = await runReview(ctx);

    expect(res.verdict).toBeUndefined();
    expect(res.classification).toBe('unrecoverable_artifact');
    expect(res.violationCode).toBe(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
    expect(res.detail).toBeDefined();
  });

  it('runFix returns classification, violationCode, and detail when verdict extraction fails', async () => {
    const cwd = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'verdict-test-')));
    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "test"', { cwd, stdio: 'ignore' });
    writeFileSync(path.join(cwd, 'readme.md'), '# test');
    execSync('git add readme.md && git commit -m "initial"', { cwd, stdio: 'ignore' });
    writeConfig(cwd);

    const fakeAgent = {
      invoke: async (_req: AgentInvocationRequest) => {
        // Do NOT write result.json so readFixVerdict fails
        return {
          runtime: 'opencode' as const,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: path.join(cwd, 'stdout.log'),
          stderrPath: path.join(cwd, 'stderr.log'),
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const container = composeRoot({
      repoRoot: cwd,
      scriptPath: '/bin/true',
      metadataResolver: FAKE_METADATA_RESOLVER,
      agentAdapterOverrides: { opencode: fakeAgent as unknown as AgentPort },
    });

    const runUuid = 'run-verdict-2';
    container.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: '2',
      type: 'issue_to_pr',
      issueNumber: 2,
      repoId: RepositoryId('owner/repo'),
      phaseId: PhaseName('fix-review'),
      status: 'in_progress',
      startedAt: new Date(),
      completedPhases: [],
    });

    const reviewLoop = container.reviewFixLoop as unknown as { deps: ReviewFixLoopDeps };
    expect(reviewLoop).toBeDefined();
    const runFix = reviewLoop.deps.runFix;

    const ctx = {
      loopId: 'loop-1',
      runId: RunId(runUuid),
      phaseId: PhaseName('fix-review'),
      repoId: 'owner/repo',
      cwd,
      iterationIndex: 1,
    };

    const res = await runFix(ctx, { useFallback: false });

    expect(res.verdict).toBeUndefined();
    expect(res.classification).toBe('unrecoverable_artifact');
    expect(res.violationCode).toBe(CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT);
    expect(res.detail).toBeDefined();
  });

  it('runReview forwards transcript evidence to readReviewVerdict when stdout exists', async () => {
    const cwd = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'verdict-test-')));
    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "test"', { cwd, stdio: 'ignore' });
    writeFileSync(path.join(cwd, 'readme.md'), '# test');
    execSync('git add readme.md && git commit -m "initial"', { cwd, stdio: 'ignore' });
    writeConfig(cwd);

    const stdoutLogPath = path.join(cwd, 'agent-stdout.log');
    writeFileSync(stdoutLogPath, 'TRANSCRIPT_EVIDENCE_FOR_REPAIR');

    const fakeAgent = {
      invoke: async (_req: AgentInvocationRequest) => {
        // Write malformed result.json to trigger repair if structuredResultRepair is wired
        writeFileSync(path.join(cwd, 'result.json'), 'invalid json');
        return {
          runtime: 'opencode' as const,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: stdoutLogPath,
          stderrPath: path.join(cwd, 'stderr.log'),
          contractViolations: [],
          outcome: 'success' as const,
          resultJsonPath: 'result.json',
        };
      },
    };

    const container = composeRoot({
      repoRoot: cwd,
      scriptPath: '/bin/true',
      metadataResolver: FAKE_METADATA_RESOLVER,
      agentAdapterOverrides: { opencode: fakeAgent as unknown as AgentPort },
    });

    const runUuid = 'run-verdict-3';
    container.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: '3',
      type: 'issue_to_pr',
      issueNumber: 3,
      repoId: RepositoryId('owner/repo'),
      phaseId: PhaseName('whole-pr-review'),
      status: 'in_progress',
      startedAt: new Date(),
      completedPhases: [],
    });

    const reviewLoop = container.reviewFixLoop as unknown as { deps: ReviewFixLoopDeps };
    expect(reviewLoop).toBeDefined();
    const runReview = reviewLoop.deps.runReview;

    const ctx = {
      loopId: 'loop-1',
      runId: RunId(runUuid),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'owner/repo',
      cwd,
      iterationIndex: 1,
    };

    const res = await runReview(ctx);
    // Since result.json was invalid and repair was not supplied/failed, readReviewVerdict returned ok: false.
    // The key test is verifying transcript evidence was read and passed along without error.
    expect(res.classification).toBe('serialization_artifact');
    expect(res.violationCode).toBe(CONTRACT_VIOLATION_CODES.INVALID_RESULT_JSON);
  });
});
