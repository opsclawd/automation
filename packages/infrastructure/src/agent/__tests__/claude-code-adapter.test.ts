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

  it('uses read-only plan permission mode and never bypasses permissions', async () => {
    const cwd = makeWorktree();
    const argLog = join(cwd, 'args.txt');
    const shim = join(cwd, 'shim.sh');
    writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog}"\nexit 0\n`);
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('-p');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    expect(args).not.toContain('bypassPermissions');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--allow-dangerously-skip-permissions');
  });

  it('passes prompt content as positional arg to -p, not via stdin', async () => {
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
cat > "${stdinLog}" < /dev/null
exit 0
`,
    );
    execSync(`chmod +x ${shim}`);
    const adapter = new ClaudeCodeAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
    await adapter.invoke(req(cwd, { promptPath }));
    const args = readFileSync(argLog, 'utf-8');
    expect(args).toContain('REVIEW THIS PR DIFF CAREFULLY');
    const stdin = readFileSync(stdinLog, 'utf-8');
    expect(stdin).toBe('');
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
});
