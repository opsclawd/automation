import { describe, expect, it } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { RepositoryRuntimePaths } from '../repository-runtime-paths.js';
import type { Repository } from '@ai-sdlc/domain';

function makeRepository(owner: string, name: string, fullName: string): Repository {
  return {
    id: RepositoryId(`${owner}/${name}`),
    owner,
    name,
    fullName,
    defaultBranch: 'main',
    remoteUrl: `https://github.com/${fullName}.git`,
    localBasePath: `/tmp/repos/${fullName}`,
    enabled: true,
    maxConcurrentRuns: 1,
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RepositoryRuntimePaths', () => {
  describe('create', () => {
    it('rejects an unsafe repository path segment', () => {
      const unsafeCases = [
        { owner: '..', name: 'repo', reason: 'owner is ..' },
        { owner: '.', name: 'repo', reason: 'owner is .' },
        { owner: 'owner', name: '..', reason: 'name is ..' },
        { owner: 'owner', name: '.', reason: 'name is .' },
        { owner: 'owner/name', name: 'repo', reason: 'owner contains /' },
        { owner: 'owner', name: 'repo/sub', reason: 'name contains /' },
        { owner: '', name: 'repo', reason: 'owner is empty' },
        { owner: 'owner', name: '', reason: 'name is empty' },
        {
          owner: 'ow' + String.fromCharCode(92) + 'ner',
          name: 'repo',
          reason: 'owner contains backslash',
        },
      ];

      for (const { owner, name, reason } of unsafeCases) {
        const repo = makeRepository(owner, name, `${owner}/${name}`);
        expect(
          () => RepositoryRuntimePaths.create({ stateRoot: '/state', repository: repo }),
          reason,
        ).toThrow();
      }
    });

    it('rejects owner/name inconsistent with fullName', () => {
      const repo = makeRepository('acme', 'api', 'acme/web');
      expect(() =>
        RepositoryRuntimePaths.create({ stateRoot: '/state', repository: repo }),
      ).toThrow('fullName');
    });
  });

  describe('cross-repository path separation', () => {
    it('derives distinct paths for equal issue and run identifiers in different repositories', () => {
      const stateRoot = '/state';
      const repoApi = makeRepository('acme', 'api', 'acme/api');
      const repoWeb = makeRepository('acme', 'web', 'acme/web');
      const pathsApi = RepositoryRuntimePaths.create({ stateRoot, repository: repoApi });
      const pathsWeb = RepositoryRuntimePaths.create({ stateRoot, repository: repoWeb });

      const issueNumber = 42;
      const displayId = 'run-001';
      const runUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

      expect(pathsApi.worktree(issueNumber)).not.toBe(pathsWeb.worktree(issueNumber));
      expect(pathsApi.run(displayId)).not.toBe(pathsWeb.run(displayId));
      expect(pathsApi.database()).not.toBe(pathsWeb.database());
      expect(pathsApi.tmp(runUuid)).not.toBe(pathsWeb.tmp(runUuid));
    });

    it('derives every execution path from one repository namespace', () => {
      const stateRoot = '/state';
      const repoApi = makeRepository('acme', 'api', 'acme/api');
      const repoWeb = makeRepository('acme', 'web', 'acme/web');
      const pathsApi = RepositoryRuntimePaths.create({ stateRoot, repository: repoApi });
      const pathsWeb = RepositoryRuntimePaths.create({ stateRoot, repository: repoWeb });

      const issueNumber = 42;
      const displayId = 'run-001';
      const runUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const checkId = 'check-001';
      const purpose = 'implementation';

      const apiWorktree = pathsApi.worktree(issueNumber);
      const webWorktree = pathsWeb.worktree(issueNumber);
      expect(apiWorktree).toBe('/state/.ai-worktrees/acme/api/issue-42');
      expect(webWorktree).toBe('/state/.ai-worktrees/acme/web/issue-42');
      expect(apiWorktree).toContain('acme/api');
      expect(webWorktree).toContain('acme/web');

      const apiRun = pathsApi.run(displayId);
      const webRun = pathsWeb.run(displayId);
      expect(apiRun).toBe('/state/.ai-runs/acme/api/run-001');
      expect(webRun).toBe('/state/.ai-runs/acme/web/run-001');
      expect(apiRun).toContain('acme/api');
      expect(webRun).toContain('acme/web');

      const apiDb = pathsApi.database();
      const webDb = pathsWeb.database();
      expect(apiDb).toBe('/state/.ai-state/acme/api/orchestrator.sqlite');
      expect(webDb).toBe('/state/.ai-state/acme/web/orchestrator.sqlite');
      expect(apiDb).toContain('acme/api');
      expect(webDb).toContain('acme/web');

      const apiTmp = pathsApi.tmp(runUuid);
      const webTmp = pathsWeb.tmp(runUuid);
      expect(apiTmp).toBe('/state/.ai-tmp/acme/api/a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(webTmp).toBe('/state/.ai-tmp/acme/web/a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(apiTmp).toContain('acme/api');
      expect(webTmp).toContain('acme/web');

      const apiArtifacts = pathsApi.agentArtifacts();
      const webArtifacts = pathsWeb.agentArtifacts();
      expect(apiArtifacts).toBe('/state/.ai-artifacts/acme/api');
      expect(webArtifacts).toBe('/state/.ai-artifacts/acme/web');
      expect(apiArtifacts).toContain('acme/api');
      expect(webArtifacts).toContain('acme/web');

      const apiValLog = pathsApi.validationLog(displayId, checkId);
      const webValLog = pathsWeb.validationLog(displayId, checkId);
      expect(apiValLog).toBe('/state/.ai-runs/acme/api/run-001/validation-check-001.log');
      expect(webValLog).toBe('/state/.ai-runs/acme/web/run-001/validation-check-001.log');
      expect(apiValLog).toContain('acme/api');
      expect(webValLog).toContain('acme/web');

      const apiPrompt = pathsApi.prompt(runUuid, purpose);
      const webPrompt = pathsWeb.prompt(runUuid, purpose);
      expect(apiPrompt).toBe(
        '/state/.ai-tmp/acme/api/a1b2c3d4-e5f6-7890-abcd-ef1234567890/prompt-implementation.txt',
      );
      expect(webPrompt).toBe(
        '/state/.ai-tmp/acme/web/a1b2c3d4-e5f6-7890-abcd-ef1234567890/prompt-implementation.txt',
      );
      expect(apiPrompt).toContain('acme/api');
      expect(webPrompt).toContain('acme/web');
    });
  });

  describe('path methods', () => {
    const stateRoot = '/state';
    const repo = makeRepository('acme', 'api', 'acme/api');
    const paths = RepositoryRuntimePaths.create({ stateRoot, repository: repo });

    describe('rejects unsafe segment inputs', () => {
      it('run() rejects unsafe displayId', () => {
        const unsafeCases = [
          { displayId: '..', reason: 'displayId is ..' },
          { displayId: '.', reason: 'displayId is .' },
          { displayId: '../run', reason: 'displayId contains .. traversal' },
          { displayId: './run', reason: 'displayId contains . traversal' },
          { displayId: '', reason: 'displayId is empty' },
          { displayId: 'run name', reason: 'displayId contains space' },
          { displayId: 'run/name', reason: 'displayId contains /' },
          { displayId: 'run\\name', reason: 'displayId contains backslash' },
        ];

        for (const { displayId, reason } of unsafeCases) {
          expect(() => paths.run(displayId), reason).toThrow();
        }
      });

      it('tmp() rejects unsafe runUuid', () => {
        const unsafeCases = [
          { runUuid: '..', reason: 'runUuid is ..' },
          { runUuid: '.', reason: 'runUuid is .' },
          { runUuid: '../tmp', reason: 'runUuid contains .. traversal' },
          { runUuid: './tmp', reason: 'runUuid contains . traversal' },
          { runUuid: '', reason: 'runUuid is empty' },
          { runUuid: 'uuid name', reason: 'runUuid contains space' },
          { runUuid: 'uuid/name', reason: 'runUuid contains /' },
          { runUuid: 'uuid\\name', reason: 'runUuid contains backslash' },
        ];

        for (const { runUuid, reason } of unsafeCases) {
          expect(() => paths.tmp(runUuid), reason).toThrow();
        }
      });

      it('validationLog() rejects unsafe displayId or checkId', () => {
        const unsafeCases = [
          { displayId: '..', checkId: 'check', reason: 'displayId is ..' },
          { displayId: '.', checkId: 'check', reason: 'displayId is .' },
          { displayId: '../log', checkId: 'check', reason: 'displayId contains .. traversal' },
          { displayId: '', checkId: 'check', reason: 'displayId is empty' },
          { displayId: 'run name', checkId: 'check', reason: 'displayId contains space' },
          { displayId: 'run/name', checkId: 'check', reason: 'displayId contains /' },
          { displayId: 'run', checkId: '..', reason: 'checkId is ..' },
          { displayId: 'run', checkId: '.', reason: 'checkId is .' },
          { displayId: 'run', checkId: '../check', reason: 'checkId contains .. traversal' },
          { displayId: 'run', checkId: '', reason: 'checkId is empty' },
          { displayId: 'run', checkId: 'check name', reason: 'checkId contains space' },
          { displayId: 'run', checkId: 'check/name', reason: 'checkId contains /' },
        ];

        for (const { displayId, checkId, reason } of unsafeCases) {
          expect(() => paths.validationLog(displayId, checkId), reason).toThrow();
        }
      });

      it('prompt() rejects unsafe runUuid or purpose', () => {
        const unsafeCases = [
          { runUuid: '..', purpose: 'impl', reason: 'runUuid is ..' },
          { runUuid: '.', purpose: 'impl', reason: 'runUuid is .' },
          { runUuid: '../prompt', purpose: 'impl', reason: 'runUuid contains .. traversal' },
          { runUuid: '', purpose: 'impl', reason: 'runUuid is empty' },
          { runUuid: 'uuid name', purpose: 'impl', reason: 'runUuid contains space' },
          { runUuid: 'uuid/name', purpose: 'impl', reason: 'runUuid contains /' },
          { runUuid: 'uuid', purpose: '..', reason: 'purpose is ..' },
          { runUuid: 'uuid', purpose: '.', reason: 'purpose is .' },
          { runUuid: 'uuid', purpose: '../prompt', reason: 'purpose contains .. traversal' },
          { runUuid: 'uuid', purpose: '', reason: 'purpose is empty' },
          { runUuid: 'uuid', purpose: 'prompt text', reason: 'purpose contains space' },
          { runUuid: 'uuid', purpose: 'prompt/text', reason: 'purpose contains /' },
        ];

        for (const { runUuid, purpose, reason } of unsafeCases) {
          expect(() => paths.prompt(runUuid, purpose), reason).toThrow();
        }
      });
    });

    it('exposes repositoryId', () => {
      expect(paths.repositoryId).toBe(repo.id);
    });

    it('worktree returns path for issue number', () => {
      expect(paths.worktree(42)).toBe('/state/.ai-worktrees/acme/api/issue-42');
      expect(paths.worktree(1)).toBe('/state/.ai-worktrees/acme/api/issue-1');
    });

    it('run returns path for display id', () => {
      expect(paths.run('run-001')).toBe('/state/.ai-runs/acme/api/run-001');
    });

    it('database returns operational db path', () => {
      expect(paths.database()).toBe('/state/.ai-state/acme/api/orchestrator.sqlite');
    });

    it('tmp returns temporary path for run uuid', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(paths.tmp(uuid)).toBe('/state/.ai-tmp/acme/api/a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('agentArtifacts returns artifacts directory', () => {
      expect(paths.agentArtifacts()).toBe('/state/.ai-artifacts/acme/api');
    });

    it('validationLog returns path for display id and check id', () => {
      expect(paths.validationLog('run-001', 'check-001')).toBe(
        '/state/.ai-runs/acme/api/run-001/validation-check-001.log',
      );
    });

    it('prompt returns path for run uuid and purpose', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(paths.prompt(uuid, 'implementation')).toBe(
        '/state/.ai-tmp/acme/api/a1b2c3d4-e5f6-7890-abcd-ef1234567890/prompt-implementation.txt',
      );
      expect(paths.prompt(uuid, 'review')).toBe(
        '/state/.ai-tmp/acme/api/a1b2c3d4-e5f6-7890-abcd-ef1234567890/prompt-review.txt',
      );
    });
  });
});
