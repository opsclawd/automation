import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { composeRoot } from '../compose.js';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application';
import type { AgentPort, AgentInvocationRequest } from '@ai-sdlc/application/ports';

const FAKE_METADATA_RESOLVER = {
  resolve: (p: string) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

function writeConfig(cwd: string) {
  const config = {
    validation: { commands: ['echo ok'], timeout: 60 },
    phases: { skip: [], reviewFix: { maxIterations: 1 }, implement: { maxIterations: 1 } },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    agent: {
      defaultProfile: 'reviewer-profile',
      profiles: {
        'reviewer-profile': {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          timeoutMinutes: 10,
        },
        'repair-profile': {
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          timeoutMinutes: 10,
        },
      },
      phaseProfiles: {
        'whole-pr-review': { profile: 'reviewer-profile' },
        'fix-review': { profile: 'reviewer-profile' },
        'result-writer': { profile: 'repair-profile' },
        implement: { profile: 'reviewer-profile' },
        'spec-review': { profile: 'reviewer-profile' },
        'quality-review': { profile: 'reviewer-profile' },
      },
    },
  };
  writeFileSync(path.join(cwd, '.ai-orchestrator.json'), JSON.stringify(config), 'utf-8');
}

function createWorktreeEnvironment() {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'artifact-recovery-repo-'));
  execSync('git init', { cwd: baseDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: baseDir, stdio: 'ignore' });
  execSync('git config user.name "test"', { cwd: baseDir, stdio: 'ignore' });
  writeFileSync(
    path.join(baseDir, '.gitignore'),
    '.ai-runs/\n.ai-tmp/\n.ai-orchestrator.json\n*.log\n',
  );
  writeFileSync(path.join(baseDir, 'readme.md'), '# test');
  execSync('git add . && git commit -m "initial"', { cwd: baseDir, stdio: 'ignore' });

  const worktree = mkdtempSync(path.join(os.tmpdir(), 'artifact-recovery-worktree-'));
  execSync(`git worktree add "${worktree}" -b test-branch`, { cwd: baseDir, stdio: 'ignore' });
  writeConfig(worktree);

  const cleanup = () => {
    try {
      execSync(`git worktree remove --force "${worktree}"`, { cwd: baseDir, stdio: 'ignore' });
    } catch {}
    rmSync(worktree, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  };

  return { worktree, cleanup };
}

describe('whole-pr-review artifact recovery at composition boundary', () => {
  it('records missing_required_artifact when a successful reviewer writes neither required artifact', async () => {
    const { worktree, cleanup } = createWorktreeEnvironment();
    try {
      let repairRequest: AgentInvocationRequest | undefined;

      const fakeAgent: AgentPort = {
        invoke: async (req: AgentInvocationRequest) => {
          if (req.profile === 'repair-profile') {
            repairRequest = req;
            writeFileSync(
              path.join(req.cwd, 'result.json'),
              JSON.stringify({ result: 'pass', findings: [] }),
            );
            return {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              exitCode: 0,
              durationMs: 10,
              stdoutPath: path.join(os.tmpdir(), `repair-stdout-${Math.random()}.log`),
              stderrPath: path.join(os.tmpdir(), `repair-stderr-${Math.random()}.log`),
              contractViolations: [],
              outcome: 'success',
            };
          }

          const stdoutPath = path.join(os.tmpdir(), `stdout-${Math.random()}.log`);
          writeFileSync(
            stdoutPath,
            'Review completed successfully with concrete findings in stdout evidence',
          );
          return {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            exitCode: 0,
            durationMs: 10,
            stdoutPath,
            stderrPath: path.join(os.tmpdir(), `stderr-${Math.random()}.log`),
            contractViolations: [],
            outcome: 'success',
          };
        },
      };

      const container = composeRoot({
        repoRoot: worktree,
        scriptPath: '/bin/true',
        metadataResolver: FAKE_METADATA_RESOLVER,
        agentAdapterOverrides: { opencode: fakeAgent },
      });

      const runUuid = 'run-recovery-1';
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

      expect(container.reviewFixLoop).toBeDefined();
      const result = await container.reviewFixLoop!.execute({
        runId: RunId(runUuid),
        phaseId: PhaseName('review-fix'),
        repoId: 'owner/repo',
        cwd: worktree,
        maxIterations: 1,
        reviewProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
        fixProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
      });

      const invocations = container.agentInvocationRepository.listByRun(RunId(runUuid));
      const primaryRow = invocations[0];

      expect(result.phaseOutcome).toBe('passed');
      expect(primaryRow?.outcome).toBe('contract_violation');
      expect(primaryRow?.contractViolations).toContain(
        CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      );
      expect(repairRequest).toBeDefined();
      expect(repairRequest!.cwd).toBe(worktree);
    } finally {
      cleanup();
    }
  });

  it('passes the worktree and bounded stdout tail to structured result repair', async () => {
    const { worktree, cleanup } = createWorktreeEnvironment();
    try {
      let repairRequest: AgentInvocationRequest | undefined;

      const fakeAgent: AgentPort = {
        invoke: async (req: AgentInvocationRequest) => {
          if (req.profile === 'repair-profile') {
            repairRequest = req;
            writeFileSync(
              path.join(req.cwd, 'result.json'),
              JSON.stringify({ result: 'pass', findings: [] }),
            );
            return {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              exitCode: 0,
              durationMs: 10,
              stdoutPath: path.join(os.tmpdir(), `repair-stdout-${Math.random()}.log`),
              stderrPath: path.join(os.tmpdir(), `repair-stderr-${Math.random()}.log`),
              contractViolations: [],
              outcome: 'success',
            };
          }

          const stdoutPath = path.join(os.tmpdir(), `stdout-${Math.random()}.log`);
          writeFileSync(stdoutPath, 'Concrete review transcript evidence for repair context test');
          return {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            exitCode: 0,
            durationMs: 10,
            stdoutPath,
            stderrPath: path.join(os.tmpdir(), `stderr-${Math.random()}.log`),
            contractViolations: [],
            outcome: 'success',
          };
        },
      };

      const container = composeRoot({
        repoRoot: worktree,
        scriptPath: '/bin/true',
        metadataResolver: FAKE_METADATA_RESOLVER,
        agentAdapterOverrides: { opencode: fakeAgent },
      });

      const runUuid = 'run-recovery-2';
      container.runRepository.insertIfNoActive({
        uuid: runUuid,
        displayId: '2',
        type: 'issue_to_pr',
        issueNumber: 2,
        repoId: RepositoryId('owner/repo'),
        phaseId: PhaseName('whole-pr-review'),
        status: 'in_progress',
        startedAt: new Date(),
        completedPhases: [],
      });

      await container.reviewFixLoop!.execute({
        runId: RunId(runUuid),
        phaseId: PhaseName('review-fix'),
        repoId: 'owner/repo',
        cwd: worktree,
        maxIterations: 1,
        reviewProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
        fixProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
      });

      expect(repairRequest).toBeDefined();
      expect(repairRequest!.cwd).toBe(worktree);
      expect(repairRequest!.metadata?.transcript_evidence).toBe(
        'Concrete review transcript evidence for repair context test',
      );
    } finally {
      cleanup();
    }
  });

  it('returns a successful review step when repair reconstructs a valid verdict', async () => {
    const { worktree, cleanup } = createWorktreeEnvironment();
    try {
      const fakeAgent: AgentPort = {
        invoke: async (req: AgentInvocationRequest) => {
          if (req.profile === 'repair-profile') {
            writeFileSync(
              path.join(req.cwd, 'result.json'),
              JSON.stringify({ result: 'pass', findings: [] }),
            );
            return {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              exitCode: 0,
              durationMs: 10,
              stdoutPath: path.join(os.tmpdir(), `repair-stdout-${Math.random()}.log`),
              stderrPath: path.join(os.tmpdir(), `repair-stderr-${Math.random()}.log`),
              contractViolations: [],
              outcome: 'success',
            };
          }

          const stdoutPath = path.join(os.tmpdir(), `stdout-${Math.random()}.log`);
          writeFileSync(stdoutPath, 'Review findings in stdout');
          return {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            exitCode: 0,
            durationMs: 10,
            stdoutPath,
            stderrPath: path.join(os.tmpdir(), `stderr-${Math.random()}.log`),
            contractViolations: [],
            outcome: 'success',
          };
        },
      };

      const container = composeRoot({
        repoRoot: worktree,
        scriptPath: '/bin/true',
        metadataResolver: FAKE_METADATA_RESOLVER,
        agentAdapterOverrides: { opencode: fakeAgent },
      });

      const runUuid = 'run-recovery-3';
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

      const result = await container.reviewFixLoop!.execute({
        runId: RunId(runUuid),
        phaseId: PhaseName('review-fix'),
        repoId: 'owner/repo',
        cwd: worktree,
        maxIterations: 1,
        reviewProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
        fixProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
      });

      expect(result.phaseOutcome).toBe('passed');
    } finally {
      cleanup();
    }
  });

  it('leaves a complete reviewer invocation unchanged', async () => {
    const { worktree, cleanup } = createWorktreeEnvironment();
    try {
      let repairCalled = false;

      const fakeAgent: AgentPort = {
        invoke: async (req: AgentInvocationRequest) => {
          if (req.profile === 'repair-profile') {
            repairCalled = true;
            return {
              runtime: 'opencode',
              provider: 'anthropic',
              model: 'claude-3-5-sonnet',
              exitCode: 0,
              durationMs: 10,
              stdoutPath: path.join(os.tmpdir(), `repair-stdout-${Math.random()}.log`),
              stderrPath: path.join(os.tmpdir(), `repair-stderr-${Math.random()}.log`),
              contractViolations: [],
              outcome: 'success',
            };
          }

          writeFileSync(
            path.join(req.cwd, 'result.json'),
            JSON.stringify({ result: 'pass', findings: [] }),
          );
          writeFileSync(path.join(req.cwd, 'code-review.md'), '# Code Review\nAll clear.');
          return {
            runtime: 'opencode',
            provider: 'anthropic',
            model: 'claude-3-5-sonnet',
            exitCode: 0,
            durationMs: 10,
            stdoutPath: path.join(os.tmpdir(), `stdout-${Math.random()}.log`),
            stderrPath: path.join(os.tmpdir(), `stderr-${Math.random()}.log`),
            contractViolations: [],
            outcome: 'success',
          };
        },
      };

      const container = composeRoot({
        repoRoot: worktree,
        scriptPath: '/bin/true',
        metadataResolver: FAKE_METADATA_RESOLVER,
        agentAdapterOverrides: { opencode: fakeAgent },
      });

      const runUuid = 'run-recovery-4';
      container.runRepository.insertIfNoActive({
        uuid: runUuid,
        displayId: '4',
        type: 'issue_to_pr',
        issueNumber: 4,
        repoId: RepositoryId('owner/repo'),
        phaseId: PhaseName('whole-pr-review'),
        status: 'in_progress',
        startedAt: new Date(),
        completedPhases: [],
      });

      const result = await container.reviewFixLoop!.execute({
        runId: RunId(runUuid),
        phaseId: PhaseName('review-fix'),
        repoId: 'owner/repo',
        cwd: worktree,
        maxIterations: 1,
        reviewProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
        fixProfile: 'reviewer-profile' as import('@ai-sdlc/domain').AgentProfileName,
      });

      const invocations = container.agentInvocationRepository.listByRun(RunId(runUuid));
      const primaryRow = invocations[0];

      expect(result.phaseOutcome).toBe('passed');
      expect(repairCalled).toBe(false);
      expect(primaryRow?.outcome).toBe('success');
      expect(primaryRow?.contractViolations ?? []).not.toContain(
        CONTRACT_VIOLATION_CODES.MISSING_REQUIRED_ARTIFACT,
      );
    } finally {
      cleanup();
    }
  });
});
