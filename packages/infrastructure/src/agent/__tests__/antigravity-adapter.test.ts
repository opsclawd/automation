import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { AntigravityAgentAdapter } from '../antigravity-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

const FIXTURES = join(__dirname, '..', '__fixtures__');

function req(cwd: string, overrides = {}) {
  return {
    profile: AgentProfileName('antigravity-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'whole-pr-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

describe('AntigravityAgentAdapter', () => {
  it('returns success and runtime "antigravity" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('antigravity');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake agy success');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome for non-zero exit', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(5);
  });

  it('passes the prompt file contents as the --print argument', async () => {
    const cwd = makeWorktree();
    const promptPath = join(cwd, 'prompt.md');
    writeFileSync(promptPath, 'REVIEW THIS PR');
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new AntigravityAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { promptPath }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--print');
    expect(args).toContain('REVIEW THIS PR');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke(req(cwd, { abortSignal: controller.signal }));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
  });
});
