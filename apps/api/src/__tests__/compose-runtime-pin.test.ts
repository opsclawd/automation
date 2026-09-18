import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type ComposeOptions } from '../compose.js';
import { createRun, failRun, resumeRun, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import {
  ArchitectureReviewHandler,
  SpecReviewHandler,
  QualityReviewHandler,
  FixReviewHandler,
  FollowUpReviewHandler,
  FixValidateHandler,
  recordValidationEvidence,
  type PhaseHandlerContext,
} from '@ai-sdlc/application';
import { FakeArtifactStore, FakeGitPort, FakeAgentPort } from '@ai-sdlc/application/test-doubles';
import {
  PinnedRuntimeResolutionError,
  type PinnedRuntimeName,
  type AgentConfig,
} from '@ai-sdlc/shared';

interface HandlerWithOptions {
  opts?: { profileName?: string };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function trackDir<T extends string>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function fakeScript(exitCode = 0): string {
  const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-test-')));
  const scriptPath = path.join(dir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

const FAKE_METADATA_RESOLVER: ComposeOptions['metadataResolver'] = {
  resolve: (p) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

function createMultiRuntimeConfig(): AgentConfig {
  return {
    defaultProfile: 'opencode-default',
    profiles: {
      // Unpinned defaults
      'opencode-default': {
        runtime: 'opencode',
        provider: 'minimax',
        model: 'm1',
        timeoutMinutes: 30,
      },
      'unpinned-arch': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        timeoutMinutes: 30,
      },
      'unpinned-spec': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        timeoutMinutes: 30,
      },
      'unpinned-quality': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        timeoutMinutes: 30,
      },
      'unpinned-fix': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        timeoutMinutes: 30,
      },
      'unpinned-fallback': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-opus-4-20250514',
        timeoutMinutes: 30,
      },

      // claude-code runtime profiles
      claude: {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'claude-opus-4-20250514',
        timeoutMinutes: 30,
      },
      'claude-sonnet': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        timeoutMinutes: 30,
      },
      'claude-opus': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'claude-opus-4-20250514',
        timeoutMinutes: 30,
      },
      'claude-haiku': {
        runtime: 'claude-code',
        provider: 'anthropic',
        model: 'claude-haiku-3-5',
        timeoutMinutes: 15,
      },

      // antigravity runtime profiles
      gemini: {
        runtime: 'antigravity',
        provider: 'google',
        model: 'gemini-3.5-flash-high',
        timeoutMinutes: 30,
      },
      reviewer: {
        runtime: 'antigravity',
        provider: 'google',
        model: 'gemini-3.5-flash-high',
        timeoutMinutes: 30,
      },
      'task-reviewer': {
        runtime: 'antigravity',
        provider: 'google',
        model: 'gemini-3.5-flash-low',
        timeoutMinutes: 30,
      },

      // codex runtime profiles
      'codex-reviewer': {
        runtime: 'codex',
        provider: 'openai',
        model: 'default',
        timeoutMinutes: 45,
      },
      'codex-writer': {
        runtime: 'codex',
        provider: 'openai',
        model: 'default',
        timeoutMinutes: 45,
      },

      // opencode runtime profiles
      architect: {
        runtime: 'opencode',
        provider: 'zai-coding-plan',
        model: 'glm-5.1',
        timeoutMinutes: 30,
      },
      senior: {
        runtime: 'opencode',
        provider: 'ollama-cloud',
        model: 'glm-5.1',
        timeoutMinutes: 30,
      },
      qwen: {
        runtime: 'opencode',
        provider: 'ollama-cloud',
        model: 'qwen-2.5',
        timeoutMinutes: 30,
      },
      builder: {
        runtime: 'opencode',
        provider: 'minimax-coding-plan',
        model: 'MiniMax-M2.7',
        timeoutMinutes: 30,
      },
      junior: {
        runtime: 'opencode',
        provider: 'ollama-cloud',
        model: 'glm-4',
        timeoutMinutes: 15,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'unpinned-arch' },
      'architecture-review': { profile: 'unpinned-arch' },
      'spec-review': { profile: 'unpinned-spec' },
      'quality-review': { profile: 'unpinned-quality' },
      'fix-review': { profile: 'unpinned-fix', fallbackProfile: 'unpinned-fallback' },
      'follow-up-review': { profile: 'unpinned-quality' },
      'fix-validate': { profile: 'unpinned-fix', fallbackProfile: 'unpinned-fallback' },
    },
  };
}

function writeOrchestratorConfig(root: string, agentConfig: AgentConfig) {
  writeFileSync(
    path.join(root, '.ai-orchestrator.json'),
    JSON.stringify({
      validation: { commands: ['echo ok'], timeout: 60 },
      phases: { skip: [] },
      timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
      agent: agentConfig,
    }),
  );
}

describe('Runtime Pin compose wiring', () => {
  describe('(a) Unpinned run parity (matches baseline)', () => {
    it('constructs handlers with unpinned configured profiles when unpinned', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-')));
      const scriptPath = fakeScript();
      writeOrchestratorConfig(root, createMultiRuntimeConfig());

      const c = await composeRoot({
        repoRoot: root,
        scriptPath,
        metadataResolver: FAKE_METADATA_RESOLVER,
        runStartupSweeps: false,
      });

      const archHandler = c.phaseRegistry.get(
        PhaseName('architecture-review'),
      ) as ArchitectureReviewHandler;
      const specHandler = c.phaseRegistry.get(PhaseName('spec-review')) as SpecReviewHandler;
      const qualityHandler = c.phaseRegistry.get(
        PhaseName('quality-review'),
      ) as QualityReviewHandler;
      const fixReviewHandler = c.phaseRegistry.get(PhaseName('fix-review')) as FixReviewHandler;
      const followUpHandler = c.phaseRegistry.get(
        PhaseName('follow-up-review'),
      ) as FollowUpReviewHandler;
      const fixValidateHandler = c.phaseRegistry.get(
        PhaseName('fix-validate'),
      ) as FixValidateHandler;

      expect((archHandler as unknown as HandlerWithOptions).opts?.profileName).toBe(
        'unpinned-arch',
      );
      expect((specHandler as unknown as HandlerWithOptions).opts?.profileName).toBe(
        'unpinned-spec',
      );
      expect((qualityHandler as unknown as HandlerWithOptions).opts?.profileName).toBe(
        'unpinned-quality',
      );
      expect((fixReviewHandler as unknown as HandlerWithOptions).opts?.profileName).toBe(
        'unpinned-fix',
      );
      expect((followUpHandler as unknown as HandlerWithOptions).opts?.profileName).toBe(
        'unpinned-quality',
      );
      expect((fixValidateHandler as unknown as HandlerWithOptions).opts?.profileName).toBe(
        'unpinned-fix',
      );
    });

    it('buildContext for unpinned run resolves every phase to unpinned configured profile', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-')));
      const scriptPath = fakeScript();
      writeOrchestratorConfig(root, createMultiRuntimeConfig());

      const c = await composeRoot({
        repoRoot: root,
        scriptPath,
        metadataResolver: FAKE_METADATA_RESOLVER,
        runStartupSweeps: false,
      });

      const run = createRun({
        uuid: '00000000-0000-0000-0000-000000000001',
        displayId: 'issue-42-20260513-000000',
        issueNumber: 42,
        repoId: RepositoryId('owner/repo'),
        startedAt: new Date('2026-05-13T00:00:00Z'),
      });

      const ctx = c.buildRunContext!(run);
      expect(ctx.resolveProfile).toBeDefined();
      expect(ctx.resolveProfile!('architecture-review')).toBe('unpinned-arch');
      expect(ctx.resolveProfile!('spec-review')).toBe('unpinned-spec');
      expect(ctx.resolveProfile!('quality-review')).toBe('unpinned-quality');
      expect(ctx.resolveProfile!('fix-review')).toBe('unpinned-fix');
      expect(ctx.resolveProfile!('follow-up-review')).toBe('unpinned-quality');
      expect(ctx.resolveProfile!('fix-validate')).toBe('unpinned-fix');
    });
  });

  describe('(b) Pinned run resolves every phase to that runtime profile across all 4 runtimes', () => {
    const runtimes: PinnedRuntimeName[] = ['claude-code', 'antigravity', 'codex', 'opencode'];

    for (const runtime of runtimes) {
      it(`composeRoot({ pinnedRuntime: '${runtime}' }) constructs handlers with pinned profiles`, async () => {
        const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-')));
        const scriptPath = fakeScript();
        const config = createMultiRuntimeConfig();
        writeOrchestratorConfig(root, config);

        const c = await composeRoot({
          repoRoot: root,
          scriptPath,
          metadataResolver: FAKE_METADATA_RESOLVER,
          runStartupSweeps: false,
          pinnedRuntime: runtime,
        });

        const phases = [
          'architecture-review',
          'spec-review',
          'quality-review',
          'fix-review',
          'follow-up-review',
          'fix-validate',
        ] as const;

        for (const phase of phases) {
          const handler = c.phaseRegistry.get(PhaseName(phase));
          expect(handler).toBeDefined();
          const profileName = (handler as unknown as HandlerWithOptions).opts?.profileName;
          expect(profileName).toBeDefined();
          const profileDef = config.profiles[profileName];
          expect(profileDef).toBeDefined();
          expect(profileDef.runtime).toBe(runtime);
        }
      });

      it(`dynamically resolves run.pinnedRuntime='${runtime}' in buildContext on unpinned container`, async () => {
        const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-')));
        const scriptPath = fakeScript();
        const config = createMultiRuntimeConfig();
        writeOrchestratorConfig(root, config);

        // Container is unpinned
        const c = await composeRoot({
          repoRoot: root,
          scriptPath,
          metadataResolver: FAKE_METADATA_RESOLVER,
          runStartupSweeps: false,
        });

        // Run is pinned to the runtime
        const run = createRun({
          uuid: '00000000-0000-0000-0000-000000000002',
          displayId: 'issue-100-20260513-000000',
          issueNumber: 100,
          repoId: RepositoryId('owner/repo'),
          startedAt: new Date('2026-05-13T00:00:00Z'),
          pinnedRuntime: runtime,
        });

        const ctx = c.buildRunContext!(run);
        expect(ctx.resolveProfile).toBeDefined();

        const phases = [
          'plan-design',
          'architecture-review',
          'spec-review',
          'quality-review',
          'fix-review',
          'follow-up-review',
          'fix-validate',
        ];

        for (const phase of phases) {
          const resolvedProfile = ctx.resolveProfile!(phase);
          const profileDef = config.profiles[resolvedProfile];
          expect(profileDef).toBeDefined();
          expect(profileDef.runtime).toBe(runtime);
        }
      });
    }
  });

  describe('(c) Fallback behavior and fail-loudly semantics', () => {
    it('throws PinnedRuntimeResolutionError when pinned runtime has no matching profiles', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-')));
      const scriptPath = fakeScript();
      // Only opencode profiles exist in config
      const opencodeOnlyConfig: AgentConfig = {
        defaultProfile: 'opencode-default',
        profiles: {
          'opencode-default': {
            runtime: 'opencode',
            provider: 'minimax',
            model: 'm1',
            timeoutMinutes: 30,
          },
        },
        phaseProfiles: {
          'spec-review': { profile: 'opencode-default' },
        },
      };
      writeOrchestratorConfig(root, opencodeOnlyConfig);

      const c = await composeRoot({
        repoRoot: root,
        scriptPath,
        metadataResolver: FAKE_METADATA_RESOLVER,
        runStartupSweeps: false,
      });

      const run = createRun({
        uuid: '00000000-0000-0000-0000-000000000003',
        displayId: 'issue-101-20260513-000000',
        issueNumber: 101,
        repoId: RepositoryId('owner/repo'),
        startedAt: new Date('2026-05-13T00:00:00Z'),
        pinnedRuntime: 'claude-code', // Missing from config
      });

      const ctx = c.buildRunContext!(run);
      expect(() => ctx.resolveProfile!('spec-review')).toThrow(PinnedRuntimeResolutionError);
    });

    it('SpecReviewHandler rethrows PinnedRuntimeResolutionError instead of swallowing to default', async () => {
      const handler = new SpecReviewHandler({ profileName: 'opencode-default' });
      const cwd = '/tmp/worktree-spec';
      const runId = '00000000-0000-0000-0000-000000000004';
      const artifacts = new FakeArtifactStore();
      const git = new FakeGitPort();
      git.headByCwd.set(cwd, 'commit-1');
      git.currentBranchByCwd.set(cwd, 'ai/issue-102');
      git.statusByCwd.set(cwd, '');

      await artifacts.write({
        runId,
        relativePath: 'issue.md',
        contents: '# Issue 102',
      });
      await artifacts.write({
        runId,
        relativePath: 'design.md',
        contents: '# Design 102',
      });
      const ctx = {
        runId,
        runUuid: runId,
        issueNumber: 102,
        repoFullName: 'owner/repo',
        cwd,
        executionPolicy: 'standard',
        promptsRoot: '/tmp',
        startCommitSha: 'commit-1',
        expectedBranch: 'ai/issue-102',
        artifacts,
        git,
        agent: new FakeAgentPort(),
        events: { publish: () => {} },
        now: () => new Date(),
        resolveProfile: () => {
          throw new PinnedRuntimeResolutionError('No profile found for claude-code:critic');
        },
      } as unknown as PhaseHandlerContext;

      await recordValidationEvidence(ctx, 'validate');

      await expect(handler.run(ctx)).rejects.toThrow(PinnedRuntimeResolutionError);
    });

    it('QualityReviewHandler rethrows PinnedRuntimeResolutionError instead of swallowing to default', async () => {
      const handler = new QualityReviewHandler({ profileName: 'opencode-default' });
      const cwd = '/tmp/worktree-quality';
      const runId = '00000000-0000-0000-0000-000000000005';
      const artifacts = new FakeArtifactStore();
      const git = new FakeGitPort();
      git.headByCwd.set(cwd, 'commit-1');
      git.currentBranchByCwd.set(cwd, 'ai/issue-103');
      git.statusByCwd.set(cwd, '');

      await artifacts.write({
        runId,
        relativePath: 'issue.md',
        contents: '# Issue 103',
      });

      const ctx = {
        runId,
        runUuid: runId,
        issueNumber: 103,
        repoFullName: 'owner/repo',
        cwd,
        executionPolicy: 'standard',
        promptsRoot: '/tmp',
        startCommitSha: 'commit-1',
        expectedBranch: 'ai/issue-103',
        artifacts,
        git,
        agent: new FakeAgentPort(),
        events: { publish: () => {} },
        now: () => new Date(),
        resolveProfile: () => {
          throw new PinnedRuntimeResolutionError('No profile found for claude-code:critic');
        },
      } as unknown as PhaseHandlerContext;

      await recordValidationEvidence(ctx, 'validate');

      await expect(handler.run(ctx)).rejects.toThrow(PinnedRuntimeResolutionError);
    });

    it('FollowUpReviewHandler rethrows PinnedRuntimeResolutionError instead of swallowing to default', async () => {
      const handler = new FollowUpReviewHandler({ profileName: 'opencode-default' });
      const cwd = '/tmp/worktree-followup';
      const runId = '00000000-0000-0000-0000-000000000006';
      const artifacts = new FakeArtifactStore();
      const git = new FakeGitPort();
      git.headByCwd.set(cwd, 'commit-1');
      git.currentBranchByCwd.set(cwd, 'ai/issue-104');
      git.statusByCwd.set(cwd, '');

      await artifacts.write({
        runId,
        relativePath: 'issue.md',
        contents: '# Issue 104',
      });

      const ctx = {
        runId,
        runUuid: runId,
        issueNumber: 104,
        repoFullName: 'owner/repo',
        cwd,
        executionPolicy: 'standard',
        promptsRoot: '/tmp',
        startCommitSha: 'commit-1',
        expectedBranch: 'ai/issue-104',
        artifacts,
        git,
        agent: new FakeAgentPort(),
        events: { publish: () => {} },
        now: () => new Date(),
        resolveProfile: () => {
          throw new PinnedRuntimeResolutionError('No profile found for claude-code:critic');
        },
      } as unknown as PhaseHandlerContext;

      await recordValidationEvidence(ctx, 'validate');

      await expect(handler.run(ctx)).rejects.toThrow(PinnedRuntimeResolutionError);
    });

    it('FixValidateHandler rethrows PinnedRuntimeResolutionError instead of swallowing to default', async () => {
      const handler = new FixValidateHandler({ profileName: 'opencode-default' });
      const cwd = '/tmp/worktree-fixval';
      const runId = '00000000-0000-0000-0000-000000000007';
      const artifacts = new FakeArtifactStore();
      const git = new FakeGitPort();
      git.headByCwd.set(cwd, 'commit-1');
      git.statusByCwd.set(cwd, '');

      await artifacts.write({
        runId,
        relativePath: 'validate/failure.json',
        contents: JSON.stringify({ message: 'tests failed' }),
      });

      const ctx = {
        runId,
        runUuid: runId,
        issueNumber: 105,
        repoFullName: 'owner/repo',
        cwd,
        executionPolicy: 'standard',
        promptsRoot: '/tmp',
        startCommitSha: 'commit-1',
        artifacts,
        git,
        agent: new FakeAgentPort(),
        events: { publish: () => {} },
        now: () => new Date(),
        resolveProfile: () => {
          throw new PinnedRuntimeResolutionError('No profile found for claude-code:fixer');
        },
      } as unknown as PhaseHandlerContext;

      await expect(handler.run(ctx)).rejects.toThrow(PinnedRuntimeResolutionError);
    });

    it('FixReviewHandler rethrows PinnedRuntimeResolutionError instead of swallowing to default', async () => {
      const handler = new FixReviewHandler({ profileName: 'opencode-default' });
      const cwd = '/tmp/worktree-fixreview';
      const runId = '00000000-0000-0000-0000-000000000008';
      const artifacts = new FakeArtifactStore();
      const git = new FakeGitPort();
      git.headByCwd.set(cwd, 'commit-1');
      git.statusByCwd.set(cwd, '');

      await artifacts.write({
        runId,
        relativePath: 'code-review.md',
        contents: '# Review findings',
      });

      const ctx = {
        runId,
        runUuid: runId,
        issueNumber: 106,
        repoFullName: 'owner/repo',
        cwd,
        executionPolicy: 'standard',
        promptsRoot: '/tmp',
        startCommitSha: 'commit-1',
        artifacts,
        git,
        agent: new FakeAgentPort(),
        events: { publish: () => {} },
        now: () => new Date(),
        resolveProfile: () => {
          throw new PinnedRuntimeResolutionError('No profile found for claude-code:fixer');
        },
      } as unknown as PhaseHandlerContext;

      await expect(handler.run(ctx)).rejects.toThrow(PinnedRuntimeResolutionError);
    });
  });

  describe('(f) Resuming a run with --runtime override resolves remaining phases to new pinned runtime profile', () => {
    it('resumes failed run with explicit runtime override and confirms remaining phases use new pinned runtime profile', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-pin-')));
      const scriptPath = fakeScript();
      writeOrchestratorConfig(root, createMultiRuntimeConfig());

      const c = await composeRoot({
        repoRoot: root,
        scriptPath,
        metadataResolver: FAKE_METADATA_RESOLVER,
        runStartupSweeps: false,
      });

      const initialRun = createRun({
        uuid: '00000000-0000-0000-0000-000000000099',
        displayId: 'issue-42-20260513-000000',
        issueNumber: 42,
        repoId: RepositoryId('owner/repo'),
        startedAt: new Date('2026-05-13T00:00:00Z'),
        pinnedRuntime: 'claude-code',
      });
      const failedRun = failRun(initialRun, 'provider rate limit');

      const initialCtx = c.buildRunContext!(failedRun);
      expect(initialCtx.resolveProfile!('architecture-review')).toBe('claude');

      // Operator resumes the run with --runtime antigravity override
      const resumedRun = resumeRun(failedRun, 'architecture-review', {
        pinnedRuntime: 'antigravity',
      });
      expect(resumedRun.pinnedRuntime).toBe('antigravity');

      // Remaining phases use the new pinned runtime profile
      const resumedCtx = c.buildRunContext!(resumedRun);
      for (const phase of [
        'plan-design',
        'architecture-review',
        'spec-review',
        'quality-review',
        'fix-review',
        'follow-up-review',
        'fix-validate',
      ]) {
        const resolvedProfile = resumedCtx.resolveProfile!(phase);
        const profileDef = createMultiRuntimeConfig().profiles[resolvedProfile];
        expect(profileDef).toBeDefined();
        expect(profileDef.runtime).toBe('antigravity');
      }
    });
  });
});
