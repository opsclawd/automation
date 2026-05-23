import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { PiAgentAdapter } from '../pi-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

const FIXTURES = join(__dirname, '..', '__fixtures__');

describe('PiAgentAdapter', () => {
  it('returns success outcome for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new PiAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-pi-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('pi-local'),
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
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake pi success');
    expect(readFileSync(result.stderrPath, 'utf-8')).toContain('no errors');
  });

  it('returns failed outcome for non-zero exit', async () => {
    const cwd = makeWorktree();
    const adapter = new PiAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-pi-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke({
      profile: AgentProfileName('pi-local'),
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

  it('returns timeout when child exceeds timeout', async () => {
    const cwd = makeWorktree();
    const adapter = new PiAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-pi-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const r = await adapter.invoke({
      profile: AgentProfileName('pi-local'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      abortSignal: controller.signal,
    });
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
    expect(readFileSync(r.stdoutPath, 'utf-8')).toContain('starting');
  }, 15000);

  it('refuses to spawn when prompt exceeds promptBudgetTokens', async () => {
    const cwd = makeWorktree();
    const promptPath = join(cwd, 'big-prompt.md');
    writeFileSync(promptPath, 'x'.repeat(40_000));
    const sentinel = join(cwd, 'shim-ran');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\ntouch "${sentinel}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new PiAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    const r = await adapter.invoke({
      profile: AgentProfileName('pi-local'),
      promptPath,
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: 'a'.repeat(40),
      promptBudgetTokens: 1000,
    });
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('prompt_budget_exceeded');
    expect(existsSync(sentinel)).toBe(false);
  });

  it('terminates child on cancellation via AbortController', async () => {
    const cwd = makeWorktree();
    const adapter = new PiAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-pi-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke({
      profile: AgentProfileName('pi-local'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
  });
});
