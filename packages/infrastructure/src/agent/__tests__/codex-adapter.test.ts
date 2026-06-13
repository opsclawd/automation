import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { CodexAgentAdapter } from '../codex-adapter.js';

const dirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
  dirs.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});

const FIXTURES = join(__dirname, '..', '__fixtures__');

function req(cwd: string, overrides = {}) {
  return {
    profile: AgentProfileName('codex-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'spec-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

describe('CodexAgentAdapter', () => {
  it('returns success and runtime "codex" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('codex');
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('Review findings');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome with quota stderr preserved for the router', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-quota.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(1);
    // The router's isQuotaError reads stderrPath; must contain the signature.
    expect(readFileSync(r.stderrPath, 'utf-8')).toMatch(/quota.*exceed/i);
    expect(r.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('runs exec in a read-only sandbox and never bypasses approvals', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('-');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('workspace-write');
    expect(args).not.toContain('danger-full-access');
  });

  it('passes --color never for clean parseable output', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--color');
    expect(args).toContain('never');
  });

  it('appends --model only when model is not "default"', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { model: 'gpt-5' }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
  });

  it('omits --model when model is "default"', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new CodexAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { model: 'default' }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).not.toContain('--model');
  });

  it('propagates provider field from request through adapter to result', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd, { provider: 'openai' }));
    expect(result.provider).toBe('openai');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new CodexAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-codex-slow.sh'),
      artifactsDir: cwd,
    });
    const controller = new AbortController();
    const p = adapter.invoke(req(cwd, { abortSignal: controller.signal }));
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const r = await p;
    expect(r.outcome).toBe('failed');
    expect(r.contractViolations).toContain('cancelled_by_orchestrator');
    expect(r.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
