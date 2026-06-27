import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { AntigravityAgentAdapter } from '../antigravity-adapter.js';

const dirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
  dirs.push(dir);
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

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

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

  it('passes the prompt via --print and stdin', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      const promptPath = join(cwd, 'prompt.md');
      writeFileSync(promptPath, 'REVIEW THIS PR DIFF');
      await adapter.invoke(req(cwd, { promptPath }));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      const stdin = readFileSync(join(logDir, 'agy-last-stdin.txt'), 'utf-8');
      expect(args).toContain('--print');
      expect(args).not.toContain('REVIEW THIS PR DIFF');
      expect(stdin).toBe('REVIEW THIS PR DIFF');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('includes --dangerously-skip-permissions in args', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      expect(args).toContain('--dangerously-skip-permissions');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('registers the worktree as a workspace via --add-dir <cwd>', async () => {
    const cwd = makeWorktree();
    const logDir = mkdtempSync(join(tmpdir(), 'agy-log-'));
    try {
      const adapter = new AntigravityAgentAdapter({
        binaryPath: join(FIXTURES, 'fake-agy-args-logger.sh'),
        artifactsDir: cwd,
        env: { AGY_LOG_DIR: logDir },
      });
      await adapter.invoke(req(cwd));
      const args = readFileSync(join(logDir, 'agy-last-args.txt'), 'utf-8');
      expect(args).toContain('--add-dir');
      expect(args).toContain(cwd);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
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

  it('returns timeout outcome when child exceeds timeoutMsDefault', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-slow.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 50,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('timeout');
  });

  it('force-kills a SIGTERM-ignoring child within grace period', { timeout: 15_000 }, async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-hang.sh'),
      artifactsDir: cwd,
      timeoutMsDefault: 200,
    });
    const start = Date.now();
    const r = await adapter.invoke(req(cwd));
    const elapsed = Date.now() - start;
    expect(r.outcome).toBe('timeout');
    expect(elapsed).toBeGreaterThan(4_000);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('detects provider error in stderr when process exits 0', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-provider-error.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('QUOTA_EXCEEDED');
    expect(r.exitCode).toBe(0);
  });

  it('does not mistakenly classify provider error text in stdout as provider_error', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-provider-error-stdout-only.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('success');
    expect(r.contractViolations).not.toContain('provider_error');
  });

  it('detects provider error in stderr when process exits nonzero', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-nonzero-provider-error.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('provider_error');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('PROVIDER_ERROR');
    expect(r.exitCode).toBe(1);
  });

  it('detects silent zero-exit as contract_violation with no_output', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(r.stdoutPath, 'utf-8')).toBe('');
  });

  it('treats whitespace-only output as contract_violation with no_output', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-whitespace-only.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(r.stdoutPath, 'utf-8').trim()).toBe('');
  });

  it('skips no_output check for artifact-only phases with expectedArtifacts', async () => {
    const cwd = makeWorktree();
    writeFileSync(join(cwd, 'result.md'), 'ok');
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd, { expectedArtifacts: ['result.md'] }));
    expect(r.outcome).toBe('success');
    expect(r.contractViolations).not.toContain('no_output');
  });

  it('persists NO_OUTPUT diagnostic in stderr.log', async () => {
    const cwd = makeWorktree();
    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('NO_OUTPUT');
  });

  it('clears stale files from scratch dir before invocation', async () => {
    const cwd = makeWorktree();
    const scratchDir = mkdtempSync(join(tmpdir(), 'agy-scratch-'));
    dirs.push(scratchDir);
    writeFileSync(join(scratchDir, 'stale-issue.md'), 'old content');
    writeFileSync(join(scratchDir, 'design.md'), 'old design');
    mkdirSync(join(scratchDir, 'nested'));
    writeFileSync(join(scratchDir, 'nested', 'data.json'), '{}');

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      scratchDir,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');

    // Scratch dir itself should still exist (we clear contents, not the dir)
    expect(existsSync(scratchDir)).toBe(true);

    // All stale files should be gone
    const remaining = readdirSync(scratchDir);
    expect(remaining.length).toBe(0);
  });

  it('does not throw when scratch dir does not exist', async () => {
    const cwd = makeWorktree();
    const nonExistent = join(tmpdir(), 'agy-scratch-nonexistent');
    // Ensure it does not exist
    try {
      rmSync(nonExistent, { recursive: true, force: true });
    } catch {}

    const adapter = new AntigravityAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-agy-success.sh'),
      artifactsDir: cwd,
      scratchDir: nonExistent,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    // No error thrown — clearDirectory is a no-op for non-existent dirs
  });
});
