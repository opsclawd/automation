import { describe, it, expect } from 'vitest';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
} from '@ai-sdlc/domain';

describe('GET /api/runs/:uuid/invocations', () => {
  it('returns invocation rows for a run', async () => {
    const c = composeRoot({
      repoRoot: process.cwd(),
      scriptPath: '/bin/true',
      dbPath: ':memory:',
      runsDir: '/tmp/runs-test-' + Math.random(),
      metadataResolver: {
        resolve: () => ({
          rootPath: process.cwd(),
          nameWithOwner: 'owner/repo',
          defaultBranch: 'main',
          remoteUrl: 'git@github.com:owner/repo.git',
        }),
      },
    });
    const repo = c.registerRepository.execute({ localPath: process.cwd() });

    const runUuid = '00000000-0000-0000-0000-000000000099';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-99',
      repoId: repo.id,
      issueNumber: 99,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);
    const inv: AgentInvocation = {
      id: AgentInvocationId('inv-99'),
      runId: RunId(runUuid),
      phaseId: PhaseName('plan-design'),
      profile: AgentProfileName('opencode-frontier'),
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath: '/p',
      promptChars: 100,
      stdoutPath: '/s',
      stderrPath: '/e',
      startedAt: new Date('2026-05-22T10:00:00Z'),
      endedAt: new Date('2026-05-22T10:01:00Z'),
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 60000,
      outcome: 'success',
      durationMs: 60000,
      contractViolations: ['x'],
    };
    c.agentInvocationRepository.insert(inv);
    const app = await buildServer(c);
    const res = await app.inject({
      url: `/api/runs/${runUuid}/invocations`,
      headers: { 'x-repository-id': 'owner/repo' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invocations: Array<Record<string, unknown>> };
    expect(body.invocations).toHaveLength(1);
    const got = body.invocations[0];
    expect(got).toMatchObject({
      id: 'inv-99',
      profile: 'opencode-frontier',
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptChars: 100,
      durationMs: 60000,
      outcome: 'success',
    });
    expect(got.contractViolationsCount).toBe(1);
  });

  it('returns 400 for invalid run UUID format', async () => {
    const c = composeRoot({
      repoRoot: process.cwd(),
      scriptPath: '/bin/true',
      dbPath: ':memory:',
      runsDir: '/tmp/runs-test-' + Math.random(),
    });
    const app = await buildServer(c);
    const res = await app.inject({ url: '/api/runs/not-a-uuid/invocations' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid run uuid');
  });

  it('returns 404 for valid UUID with no matching run', async () => {
    const c = composeRoot({
      repoRoot: process.cwd(),
      scriptPath: '/bin/true',
      dbPath: ':memory:',
      runsDir: '/tmp/runs-test-' + Math.random(),
      metadataResolver: {
        resolve: () => ({
          rootPath: process.cwd(),
          nameWithOwner: 'owner/repo',
          defaultBranch: 'main',
          remoteUrl: 'git@github.com:owner/repo.git',
        }),
      },
    });
    c.registerRepository.execute({ localPath: process.cwd() });
    const app = await buildServer(c);
    const res = await app.inject({
      url: '/api/runs/00000000-0000-0000-0000-000000000999/invocations',
      headers: { 'x-repository-id': 'owner/repo' },
    });
    expect(res.statusCode).toBe(404);
  });
});
