import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { OpenCodeAgentAdapter } from '../opencode-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('OpenCodeAgentAdapter', () => {
  it('returns success outcome for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(result.outcome).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake opencode success');
    expect(readFileSync(result.stderrPath, 'utf-8')).toContain('no errors');
  });

  it('returns failed outcome for non-zero exit', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(7);
  });

  it('returns timeout outcome when child exceeds timeout', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 500,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(r.outcome).toBe('timeout');
  }, 15000);

  it('terminates child on cancellation via AbortController', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
  });
});
