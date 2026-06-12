import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { ClaudeCodeAgentAdapter } from '../claude-code-adapter.js';

const dirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-test-'));
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
    profile: AgentProfileName('claude-reviewer'),
    promptPath: join(cwd, 'README.md'),
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'quality-review',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    model: 'default',
    ...overrides,
  };
}

describe('ClaudeCodeAgentAdapter', () => {
  it('returns success and runtime "claude-code" for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke(req(cwd));
    expect(result.outcome).toBe('success');
    expect(result.runtime).toBe('claude-code');
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('OK');
    expect(result.endCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns failed outcome for non-zero exit (e.g. auth failure)', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-fail.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('failed');
    expect(r.exitCode).toBe(1);
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('Invalid API key');
  });

  it('uses bypassPermissions mode so headless runs can write artifacts', async () => {
    // The plan-design/plan-write phases must write files (e.g. design.md) and
    // explore the repo with Bash. In non-interactive `-p` mode there is nobody
    // to answer a permission prompt, so any tool that isn't pre-approved is
    // auto-denied. Plan mode is read-only and acceptEdits still blocks Bash,
    // so bypassPermissions is required for parity with the other adapters.
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    expect(args).not.toContain('plan');
  });

  it('passes prompt content via stdin, not as a CLI argument', async () => {
    const cwd = makeWorktree();
    const promptPath = join(cwd, 'prompt.md');
    writeFileSync(promptPath, 'REVIEW THIS PR DIFF CAREFULLY');
    const argLog = join(cwd, 'args.txt');
    const stdinLog = join(cwd, 'stdin.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(
      shim,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${argLog}"
cat > "${stdinLog}"
exit 0
`,
    );
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { promptPath }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).not.toContain('REVIEW THIS PR DIFF CAREFULLY');
    const stdin = readFileSync(stdinLog, 'utf-8');
    expect(stdin).toContain('REVIEW THIS PR DIFF CAREFULLY');
  });

  it('appends --model only when model is not "default"', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { model: 'opus' }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it('omits --model when model is "default"', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { model: 'default' }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).not.toContain('--model');
  });

  it('marks cancellation via AbortController as failed/cancelled_by_orchestrator', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-slow.sh'),
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

  it('detects silent zero-exit as contract_violation with no_output', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(r.contractViolations).toContain('no_output');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(r.stdoutPath, 'utf-8')).toBe('');
  });

  it('skips no_output check for artifact-only phases with expectedArtifacts', async () => {
    const cwd = makeWorktree();
    writeFileSync(join(cwd, 'result.md'), 'ok');
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd, { expectedArtifacts: ['result.md'] }));
    expect(r.outcome).toBe('success');
    expect(r.contractViolations).not.toContain('no_output');
  });

  it('persists NO_OUTPUT diagnostic in stderr.log', async () => {
    const cwd = makeWorktree();
    const adapter = new ClaudeCodeAgentAdapter({
      binaryPath: join(FIXTURES, 'fake-claude-silent-zero.sh'),
      artifactsDir: cwd,
    });
    const r = await adapter.invoke(req(cwd));
    expect(r.outcome).toBe('contract_violation');
    expect(readFileSync(r.stderrPath, 'utf-8')).toContain('NO_OUTPUT');
  });
});
