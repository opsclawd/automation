import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  RunId,
  PhaseName,
  createPrReviewComment,
  type AgentInvocation,
  type Loop,
  type Failure,
} from '@ai-sdlc/domain';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';

// Task 6 (#652): control-plane read routes must resolve the owning
// per-Repository operational runtime via `runtimeCatalog` and read from
// that runtime's ports, rather than always reading the root container's
// (legacy, shared) ports. These tests seed data directly into a resolved
// operational runtime's repositories and confirm the HTTP routes surface
// that data, proving the routes are runtime-scoped rather than root-scoped.

function buildContainer(runsDirSuffix: string) {
  const runsDir = join(tmpdir(), `ai-orch-routing-test-${runsDirSuffix}-${Math.random()}`);
  const c = composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/bin/true',
    dbPath: ':memory:',
    runsDir,
    metadataResolver: {
      resolve: (path: string) => {
        // Reject the compose-root path itself so composeRoot's legacy
        // single-repo fallback (`repoFullName`) stays empty and does not
        // implicitly scope "unscoped" list queries to a synthetic repo —
        // these tests exercise the multi-Repository registry exclusively.
        if (path === process.cwd()) {
          throw new Error('not a registered repository path');
        }
        return {
          rootPath: path,
          nameWithOwner: `owner/${basename(path)}`,
          defaultBranch: 'main',
          remoteUrl: `git@github.com:owner/${basename(path)}.git`,
        };
      },
    },
  });
  return c;
}

const dirs: string[] = [];
function tmpRepoDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ai-orch-routing-repo-${name}-`));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

async function setUpTwoRepos() {
  const c = buildContainer('two-repos');
  const repoADir = tmpRepoDir('a');
  const repoBDir = tmpRepoDir('b');
  const repoA = c.registerRepository.execute({ localPath: repoADir });
  const repoB = c.registerRepository.execute({ localPath: repoBDir });
  const runtimeA = await c.runtimeCatalog.resolve(repoA.id, { allowDisabled: true });
  const runtimeB = await c.runtimeCatalog.resolve(repoB.id, { allowDisabled: true });
  return { c, repoA, repoB, runtimeA, runtimeB };
}

function makeRun(uuid: string, repoId: string, displayId = uuid) {
  return {
    uuid,
    displayId,
    repoId,
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    skippedPhases: [],
    startedAt: new Date('2026-06-01T00:00:00Z'),
  } as never;
}

describe('repository-runtime routing (#652 Task 6)', () => {
  it('run_reads_never_cross_repository: a run inserted only into repo A runtime is served from repo A, not root or repo B', async () => {
    const { c, repoA, runtimeA } = await setUpTwoRepos();
    const app = await buildServer(c, false);
    const uuid = '11111111-1111-1111-1111-111111111111';
    runtimeA.runRepository.insert(makeRun(uuid, repoA.id));

    // Absent from the root container's own runRepository and from repo B's runtime.
    expect(c.runRepository.findByUuid(uuid)).toBeUndefined();

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}`,
      headers: { 'x-repository-id': repoA.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.uuid).toBe(uuid);
    await app.close();
  });

  it('run_reads_never_cross_repository: requesting a repo-A run under repo-B context returns not_found (no cross-repo leak)', async () => {
    const { c, repoA, repoB, runtimeA } = await setUpTwoRepos();
    const app = await buildServer(c, false);
    const uuid = '22222222-2222-2222-2222-222222222222';
    runtimeA.runRepository.insert(makeRun(uuid, repoA.id));

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}`,
      headers: { 'x-repository-id': repoB.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('disabled_repository_history_remains_readable: a disabled repository still serves historical run reads', async () => {
    const { c, repoA, runtimeA } = await setUpTwoRepos();
    c.disableRepository.execute(repoA.id);
    const app = await buildServer(c, false);
    const uuid = '33333333-3333-3333-3333-333333333333';
    runtimeA.runRepository.insert(makeRun(uuid, repoA.id));

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}`,
      headers: { 'x-repository-id': repoA.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.uuid).toBe(uuid);
    await app.close();
  });

  it('unscoped_run_list_aggregates_registered_runtimes: GET /api/runs with no repo filter aggregates across both runtimes', async () => {
    const { c, repoA, repoB, runtimeA, runtimeB } = await setUpTwoRepos();
    const app = await buildServer(c, false);
    const uuidA = '44444444-4444-4444-4444-444444444444';
    const uuidB = '55555555-5555-5555-5555-555555555555';
    runtimeA.runRepository.insert(makeRun(uuidA, repoA.id));
    runtimeB.runRepository.insert(makeRun(uuidB, repoB.id));

    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    const uuids = res.json().runs.map((r: { uuid: string }) => r.uuid);
    expect(uuids).toContain(uuidA);
    expect(uuids).toContain(uuidB);
    await app.close();
  });

  it("routes events/invocations/pr-review/review-fix/validation reads through the run's owning runtime", async () => {
    const { c, repoA, runtimeA } = await setUpTwoRepos();
    const app = await buildServer(c, false);
    const uuid = '66666666-6666-6666-6666-666666666666';
    const displayId = 'run-display-66';
    runtimeA.runRepository.insert(makeRun(uuid, repoA.id, displayId));

    runtimeA.eventRepository.insert({
      runUuid: uuid,
      level: 'info',
      type: 'phase.started',
      message: 'runtime-scoped event',
      timestamp: new Date('2026-06-01T00:00:01Z'),
    });

    const invocation: AgentInvocation = {
      id: 'inv-1' as AgentInvocation['id'],
      runId: RunId(uuid),
      phaseId: PhaseName('implement'),
      profile: 'default' as AgentInvocation['profile'],
      runtime: 'claude-code' as AgentInvocation['runtime'],
      provider: 'anthropic',
      model: 'claude',
      promptPath: '/tmp/prompt.txt',
      promptChars: 10,
      stdoutPath: '/tmp/stdout.txt',
      stderrPath: '/tmp/stderr.txt',
      startedAt: new Date('2026-06-01T00:00:02Z'),
      endedAt: new Date('2026-06-01T00:00:03Z'),
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 60000,
      outcome: 'success',
      durationMs: 1000,
      contractViolations: [],
    } as AgentInvocation;
    runtimeA.agentInvocationRepository.insert(invocation);

    runtimeA.prReviewRepository.upsertComment(
      createPrReviewComment({
        runId: RunId(uuid),
        prNumber: 5,
        commentId: 9001,
        path: 'src/a.ts',
        line: 3,
        reviewer: 'octocat',
        body: 'runtime-scoped comment',
        now: new Date('2026-06-01T00:00:03Z'),
      }),
    );

    const loop: Loop = {
      id: 'loop-1',
      runId: RunId(uuid),
      phaseId: PhaseName('review_fix'),
      type: 'review_fix',
      status: 'running',
      maxIterations: 5,
      startedAt: new Date('2026-06-01T00:00:04Z'),
      iterations: [],
    } as unknown as Loop;
    runtimeA.loopRepository.insert(loop);

    runtimeA.validationRunRepository.save({
      id: 'vr-1',
      runId: RunId(uuid),
      phaseId: PhaseName('validate'),
      startedAt: new Date('2026-06-01T00:00:05Z'),
      commands: [],
    } as never);

    const failure: Failure = {
      runUuid: uuid,
      phase: 'implement',
      kind: 'unknown',
      message: 'runtime-scoped failure',
      canRetry: false,
      suggestedAction: 'retry',
      artifacts: [],
      detectedAt: new Date('2026-06-01T00:00:06Z'),
    };
    runtimeA.failureRepository.insert(failure);

    const repoHeader = { 'x-repository-id': repoA.id };

    const eventsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/events`,
      headers: repoHeader,
    });
    expect(eventsRes.statusCode).toBe(200);
    expect(
      eventsRes
        .json()
        .events.some((e: { message: string }) => e.message === 'runtime-scoped event'),
    ).toBe(true);

    const invocationsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/invocations`,
      headers: repoHeader,
    });
    expect(invocationsRes.statusCode).toBe(200);
    expect(invocationsRes.json().invocations.some((i: { id: string }) => i.id === 'inv-1')).toBe(
      true,
    );

    const prReviewRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/pr-review`,
      headers: repoHeader,
    });
    expect(prReviewRes.statusCode).toBe(200);
    expect(
      prReviewRes
        .json()
        .comments.some((cm: { body: string }) => cm.body === 'runtime-scoped comment'),
    ).toBe(true);

    const reviewFixRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/review-fix`,
      headers: repoHeader,
    });
    expect(reviewFixRes.statusCode).toBe(200);
    expect(reviewFixRes.json().loops.some((l: { id: string }) => l.id === 'loop-1')).toBe(true);

    const validationRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/validation`,
      headers: repoHeader,
    });
    expect(validationRes.statusCode).toBe(200);
    expect(validationRes.json().validationRuns.some((v: { id: string }) => v.id === 'vr-1')).toBe(
      true,
    );

    const runRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}`,
      headers: repoHeader,
    });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().failure?.message).toBe('runtime-scoped failure');

    await app.close();
  });

  it("artifacts route lists files under the resolved runtime's own runsRoot, not the root container runsDir", async () => {
    const { c, repoA, runtimeA } = await setUpTwoRepos();
    const app = await buildServer(c, false);
    const uuid = '77777777-7777-7777-7777-777777777777';
    const displayId = 'run-display-77';
    runtimeA.runRepository.insert(makeRun(uuid, repoA.id, displayId));

    const runDir = join(runtimeA.paths.runsRoot(), displayId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'note.txt'), 'runtime-scoped artifact');
    dirs.push(runtimeA.paths.runsRoot());

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/artifacts`,
      headers: { 'x-repository-id': repoA.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().files.some((f: { path: string }) => f.path === 'note.txt')).toBe(true);

    await app.close();
  });
});
